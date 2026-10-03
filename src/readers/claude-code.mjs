import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classify } from "../classify.mjs";
import { findJsonl } from "../files.mjs";
import { jsonlLines } from "../lines.mjs";
import { agree, count } from "../words.mjs";

const DEFAULT_CLEANUP_DAYS = 30;

export const name = "Claude Code";
export const table = new URL("../../spec/signatures/claude-code.json", import.meta.url);
export const home = (env) => env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
export const find = (dir) => findJsonl(join(dir, "projects"));
export const owns = (file) => !file.split("/").pop().startsWith("rollout-");

/** Numbers only this agent has, added to a finished scan. */
export function finish(result, stats, dir) {
  result.cleanup = cleanupPeriodDays(dir);
}

export function blindSpots(r) {
  const out = [{ id: "retention",
                 text: `Claude Code deletes transcripts after ${r.cleanup.days} days (${r.cleanup.source}). ` +
                       `Nothing before ${r.period.from?.slice(0, 10) ?? "the oldest file"} is visible.` }];
  const cut = r.bySignature["cc.classifier-interrupted"];
  if (cut) {
    out.push({ id: "cut-mid-run", text: `${count(cut, "refused call")} ${agree(cut, "was", "were")} stopped by a safety classifier ` +
                                        "while running and may have partly or fully completed." });
  }
  return out;
}

/** cleanupPeriodDays from the user's settings, or the documented default. */
export function cleanupPeriodDays(configDir) {
  try {
    const s = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
    if (Number.isFinite(s.cleanupPeriodDays)) return { days: s.cleanupPeriodDays, source: "settings.json" };
  } catch {}
  return { days: DEFAULT_CLEANUP_DAYS, source: "default" };
}

/**
 * Read one Claude Code transcript and yield an Act per tool call.
 *
 * Calls and results are paired by tool_use id. A call with no result by the end
 * of the file is yielded with outcome "no-result". Malformed lines are counted
 * in `stats`, never thrown.
 */
export async function* read(file, table, stats = newStats()) {
  const pending = new Map();
  const timedOut = new Set();
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
    noteMeta(rec, stats);
    const att = rec.attachment;
    if (att?.type === "hook_cancelled" && att.timedOut && att.hookEvent === "PreToolUse") {
      timedOut.add(att.toolUseID);
      stats.hookTimeouts++;
      continue;
    }
    for (const block of contentBlocks(rec)) {
      if (block.type === "tool_use") {
        pending.set(block.id, { rec, block, line: n });
      } else if (block.type === "tool_result") {
        const call = pending.get(block.tool_use_id);
        pending.delete(block.tool_use_id);
        yield act(file, call, { rec, block, line: n }, table, timedOut);
      }
    }
  }
  for (const call of pending.values()) yield act(file, call, null, table, timedOut);
}

export function newStats() {
  return { malformedLines: 0, hookTimeouts: 0, versions: new Map() };
}

function act(file, call, result, table, timedOut) {
  const base = call?.rec ?? result.rec;
  const id = call?.block.id ?? result.block.tool_use_id;
  const out = {
    agent: "claude-code",
    id,
    session: base.sessionId ?? null,
    subagent: base.agentId ?? null,
    sidechain: Boolean(base.isSidechain),
    project: base.cwd ?? null,
    version: base.version ?? null,
    tool: call?.block.name ?? null,
    target: call ? summarise(call.block.input) : null,
    ts: result?.rec.timestamp ?? base.timestamp ?? null,
    outcome: "ok",
    refusal: null,
    hookTimedOut: timedOut.has(id),
    source: { file, line: result?.line ?? call.line },
  };
  if (!result) return { ...out, outcome: "no-result" };
  if (!result.block.is_error) return out;
  const refusal = classify({ text: resultText(result.block), denialKind: result.rec.toolDenialKind, sidechain: out.sidechain }, table);
  if (!refusal) return { ...out, outcome: "failed" };
  return { ...out, outcome: "refused", refusal, text: resultText(result.block).slice(0, 300) };
}

function contentBlocks(rec) {
  const c = rec.message?.content;
  return Array.isArray(c) ? c.filter((b) => b && typeof b === "object") : [];
}

function resultText(block) {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("\n");
  return "";
}

function summarise(input = {}) {
  const s = input.command ?? input.file_path ?? input.url ?? input.pattern ?? input.query ?? input.description;
  return String(s ?? JSON.stringify(input)).replace(/\s+/g, " ").slice(0, 160);
}

function noteMeta(rec, stats) {
  if (rec.version) stats.versions.set(rec.version, (stats.versions.get(rec.version) ?? 0) + 1);
}
