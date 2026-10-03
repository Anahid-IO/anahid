import { homedir } from "node:os";
import { join } from "node:path";
import { classify } from "../classify.mjs";
import { agree, count } from "../words.mjs";
import { findJsonl } from "../files.mjs";
import { jsonlLines } from "../lines.mjs";

export const name = "Codex";
export const table = new URL("../../spec/signatures/codex.json", import.meta.url);
export const home = (env) => env.CODEX_HOME || join(homedir(), ".codex");
export const owns = (file) => file.split("/").pop().startsWith("rollout-");
export const find = (dir) => [...findJsonl(join(dir, "sessions")), ...findJsonl(join(dir, "archived_sessions"))].filter(owns);
export const hasReviewer = true;

/** Numbers only this agent has, added to a finished scan. */
export function finish(result, stats) {
  result.personReviewedTurns = stats.personReviewedTurns;
  result.sandboxSuspects = stats.sandboxSuspects;
  result.unreadExecErrors = stats.unreadExecErrors;
}

export function blindSpots(r) {
  const out = [
    { id: "retention", text: `Nothing before ${r.period.from?.slice(0, 10) ?? "the oldest file"} is on disk.` },
    { id: "person-decisions",
      text: "Codex does not save a person's approval decisions. " +
            `${count(r.personReviewedTurns, "turn")} ran with a person as the approver, and what they allowed or refused is not on record.` },
    { id: "no-refusal-field",
      text: "Codex has no field that marks a refusal. A refusal worded in a way this version does not know is counted as a failure." +
            (r.unreadExecErrors ? ` ${count(r.unreadExecErrors, "command")} failed before starting with an error this version cannot read.` : "") },
  ];
  if (r.sandboxSuspects) {
    out.push({ id: "sandbox-eperm",
               text: `${count(r.sandboxSuspects, "failed command")} ${agree(r.sandboxSuspects, "reports", "report")} "Operation not permitted" inside the sandbox. ` +
                     "Codex does not say whether its sandbox or the system refused them, so they are counted as failures." });
  }
  const unmatched = r.reviews.requests - r.reviews.matched;
  if (unmatched) {
    out.push({ id: "review-unmatched", text: `${count(unmatched, "reviewer verdict")} could not be matched to the act they judged.` });
  }
  if (r.reviews.noVerdict) {
    out.push({ id: "review-no-verdict", text: `${count(r.reviews.noVerdict, "automatic review")} ${agree(r.reviews.noVerdict, "has", "have")} no verdict on record.` });
  }
  return out;
}

const TOOL_ITEMS = {
  CommandExecution: (it) => ["exec_command", shellCommand(it.command)],
  FileChange: (it) => ["apply_patch", Object.keys(it.changes ?? {}).sort().join(", ")],
  McpToolCall: (it) => [`mcp:${it.server}`, `${it.tool} ${JSON.stringify(it.arguments ?? {})}`],
  Extension: (it) => [it.kind ?? "extension", it.query ?? it.action?.query ?? ""],
  ImageView: (it) => ["view_image", it.path ?? ""],
  CollabAgentToolCall: (it) => [`collab:${it.tool}`, (it.receiver_agents ?? []).join(", ")],
};

const KNOWN_STATUS = new Set(["completed", "failed", "declined", null, undefined]);

// A command the approval layer refused never starts, so it has no item. The
// refusal survives only in the exec script's error text, as Rust Debug output.
const REJECTED = /exec_command failed(?: for `([^`]*)`)?: CreateProcess \{ message: "((?:[^"\\]|\\.)*)" \}/g;
// A refused patch is a plain line in the script's error text.
const PATCH_REJECTED = /^patch rejected: (.+)$/gm;

/**
 * Read one Codex rollout and yield its acts, or, for an automatic reviewer's
 * own rollout, its reviews.
 *
 * Acts come from completed items and from refusals recorded only as text.
 * Reviews pair each approval request with the verdict that followed it.
 */
export async function* read(file, table, stats = newStats()) {
  const ctx = { file, session: null, subagent: null, sidechain: false, guardian: false,
                version: null, cwd: null, reviewer: null, policy: null, sandbox: null };
  let review = null;
  let items = 0;
  const fromOutputs = [];
  const scripts = new Map();
  const patches = new Map();
  let n = 0;
  for await (const raw of jsonlLines(file)) {
    n++;
    if (!raw.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      stats.malformedLines++;
      continue;
    }
    const p = rec.payload ?? {};
    if (rec.type === "session_meta") {
      noteSession(ctx, p, stats);
      continue;
    }
    if (rec.type === "turn_context") {
      noteTurn(ctx, p, stats);
      continue;
    }

    if (ctx.guardian) {
      if (rec.type === "response_item" && p.type === "message" && p.role === "user") {
        const action = plannedAction(p.content);
        if (action) {
          if (review) yield review;
          review = { type: "review", session: ctx.session, parent: ctx.parent, ts: rec.timestamp ?? null, ...action,
                     outcome: null, risk: null, authorization: null, rationale: null, source: { file, line: n } };
        }
      } else if (rec.type === "event_msg" && review && (p.type === "task_complete" || p.type === "turn_aborted")) {
        Object.assign(review, verdict(p.last_agent_message));
        yield review;
        review = null;
      }
      continue;
    }

    if (rec.type === "event_msg" && p.type === "item_completed" && Object.hasOwn(TOOL_ITEMS, p.item?.type)) {
      items++;
      yield itemAct(ctx, p.item, rec, n, table, stats);
    } else if (rec.type === "response_item" && p.type === "custom_tool_call" && p.name === "exec") {
      scripts.set(p.call_id, scriptCommands(p.input));
      patches.set(p.call_id, patchedFiles(p.input));
    } else if (rec.type === "response_item" && /_call_output$/.test(p.type ?? "")) {
      const commands = scripts.get(p.call_id) ?? [];
      const text = outputText(p.output);
      for (const m of text.matchAll(REJECTED)) {
        yield rejectedAct(ctx, m, rec, n, table, stats, commands.length === 1 ? commands[0] : "");
      }
      for (const m of text.matchAll(PATCH_REJECTED)) {
        const refusal = classify({ text: m[1], denialKind: "rejected" }, table);
        yield { ...base(ctx, "apply_patch", patches.get(p.call_id) ?? "", rec, n), outcome: "refused", refusal, text: m[1].slice(0, 300) };
      }
      execResults(p.output).forEach((res, i) => fromOutputs.push({ ...res, command: commands[i] ?? "", rec, line: n }));
    }
  }
  if (review) yield review;
  // Some configurations write no item events; then the exec script's output is the only record of each command.
  if (!items) {
    for (const res of fromOutputs) yield outputAct(ctx, res, stats);
  }
}

export function newStats() {
  return { malformedLines: 0, versions: new Map(), personReviewedTurns: 0, sandboxSuspects: 0, unreadExecErrors: 0 };
}

function itemAct(ctx, it, rec, line, table, stats) {
  const [tool, target] = TOOL_ITEMS[it.type](it);
  const a = { ...base(ctx, tool, target, rec, line), id: it.id ?? null };
  if (it.status === "failed") {
    if (ctx.sandbox !== "danger-full-access" && /Operation not permitted|EPERM/.test(it.aggregated_output || it.stderr || "")) {
      stats.sandboxSuspects++;
    }
    return { ...a, outcome: "failed" };
  }
  if (KNOWN_STATUS.has(it.status) && it.status !== "declined") return a;
  const text = it.stderr || it.aggregated_output || "";
  const refusal = classify({ text, denialKind: it.status }, table);
  return { ...a, outcome: "refused", refusal, text: text.slice(0, 300) };
}

function outputAct(ctx, res, stats) {
  const a = base(ctx, "exec_command", res.command, res.rec, res.line);
  if (res.exit_code === 0) return a;
  if (ctx.sandbox !== "danger-full-access" && /Operation not permitted|EPERM/.test(res.output ?? "")) stats.sandboxSuspects++;
  return { ...a, outcome: "failed" };
}

/** The commands an exec script passes to tools.exec_command, in order. */
function scriptCommands(input = "") {
  return [...String(input).matchAll(/exec_command\(\{\s*cmd:\s*(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)]
    .map((m) => m[1].slice(1, -1));
}

/** The files a patch in an exec script adds, updates or deletes. */
function patchedFiles(input = "") {
  return [...String(input).matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\n\\]+)/g)].map((m) => m[1].trim()).sort().join(", ");
}

/** Each command result an exec script printed: objects carrying an exit_code, however nested. */
function execResults(output) {
  const found = [];
  const walk = (v) => {
    if (!v || typeof v !== "object") return;
    if (Number.isInteger(v.exit_code)) return found.push({ exit_code: v.exit_code, output: String(v.output ?? "") });
    for (const x of Object.values(v)) walk(x);
  };
  for (const part of Array.isArray(output) ? output : [output]) {
    const text = typeof part === "string" ? part : part?.text;
    for (const line of String(text ?? "").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        walk(JSON.parse(line));
      } catch {}
    }
  }
  return found;
}

function rejectedAct(ctx, m, rec, line, table, stats, scripted) {
  const [, command, debug] = m;
  const inner = /^(\w+)\("((?:[^"\\]|\\.)*)"\)$/s.exec(unescapeDebug(debug));
  const a = base(ctx, "exec_command", command ? unwrapShell(command) : scripted, rec, line);
  if (inner?.[1] !== "Rejected") {
    stats.unreadExecErrors++;
    return { ...a, outcome: "failed" };
  }
  const text = unescapeDebug(inner[2]);
  const refusal = classify({ text, denialKind: "Rejected" }, table);
  return { ...a, outcome: "refused", refusal, text: text.slice(0, 300) };
}

function base(ctx, tool, target, rec, line) {
  return {
    agent: "codex",
    id: null,
    session: ctx.session,
    subagent: ctx.subagent,
    sidechain: ctx.sidechain,
    project: ctx.cwd,
    version: ctx.version,
    tool,
    target: String(target).replace(/\s+/g, " ").slice(0, 160),
    ts: rec.timestamp ?? null,
    outcome: "ok",
    refusal: null,
    hookTimedOut: false,
    reviewer: ctx.reviewer,
    source: { file: ctx.file, line },
  };
}

function noteSession(ctx, p, stats) {
  const sub = p.source?.subagent;
  ctx.session = p.id ?? ctx.session;
  ctx.parent = p.parent_thread_id ?? ctx.parent ?? null;
  ctx.cwd = p.cwd ?? ctx.cwd;
  ctx.version = p.cli_version ?? ctx.version;
  ctx.sidechain = Boolean(sub);
  ctx.subagent = p.agent_nickname ?? p.agent_path ?? (sub ? "subagent" : null);
  ctx.guardian = sub?.other === "guardian" || p.thread_source === "guardian_review";
  if (p.cli_version) stats.versions.set(p.cli_version, (stats.versions.get(p.cli_version) ?? 0) + 1);
}

function noteTurn(ctx, p, stats) {
  ctx.cwd = p.cwd ?? ctx.cwd;
  ctx.reviewer = p.approvals_reviewer ?? null;
  ctx.policy = typeof p.approval_policy === "string" ? p.approval_policy : JSON.stringify(p.approval_policy ?? null);
  ctx.sandbox = p.sandbox_policy?.type ?? null;
  if (!ctx.guardian && ctx.reviewer === "user" && ctx.policy !== "never") stats.personReviewedTurns++;
}

function plannedAction(content) {
  const text = outputText(content);
  const m = /Planned action JSON:\n([\s\S]*?)\n>>> APPROVAL REQUEST END/.exec(text);
  if (!m) return null;
  let a;
  try {
    a = JSON.parse(m[1]);
  } catch {
    return { tool: null, target: m[1].slice(0, 160), justification: null };
  }
  const target = Array.isArray(a.command) ? shellCommand(a.command)
    : Array.isArray(a.files) ? [...a.files].sort().join(", ")
    : a.path ?? a.command ?? JSON.stringify(a);
  return { tool: a.tool ?? null, target: String(target).replace(/\s+/g, " ").slice(0, 160),
           justification: a.justification ?? null };
}

function verdict(message) {
  try {
    const v = JSON.parse(message);
    return { outcome: v.outcome ?? null, risk: v.risk_level ?? null,
             authorization: v.user_authorization ?? null, rationale: v.rationale?.slice(0, 300) ?? null };
  } catch {
    return {};
  }
}

function shellCommand(cmd) {
  if (!Array.isArray(cmd)) return String(cmd ?? "");
  const i = cmd.findIndex((c) => c === "-lc" || c === "-c");
  return i >= 0 && cmd[i + 1] ? cmd[i + 1] : cmd.join(" ");
}

/** `/bin/zsh -lc 'cmd'` as Codex prints it in an error, reduced to `cmd`. */
function unwrapShell(s) {
  const m = /^\S+ -l?c '(.*)'$/s.exec(s);
  return m ? m[1].replace(/'\\''/g, "'") : s;
}

function outputText(o) {
  if (typeof o === "string") return o;
  if (Array.isArray(o)) return o.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return "";
}

function unescapeDebug(s) {
  return s.replace(/\\(.)/gs, (_, c) => ({ n: "\n", t: "\t", r: "\r" })[c] ?? c);
}
