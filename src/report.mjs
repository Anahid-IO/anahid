import { homedir } from "node:os";
import { AGENTS } from "./scan.mjs";
import { agree, count, n } from "./words.mjs";

const LAYER_TEXT = {
  person: "a person said no",
  unanswered: "approval was requested and nobody answered",
  rule: "a permission rule in settings",
  hook: "a PreToolUse hook blocked it",
  classifier: "an automatic classifier or reviewer",
  program: "a program answered the approval prompt",
  sandbox: "the sandbox",
  builtin: "a built-in safety check",
  interrupted: "the session was interrupted",
  unknown: "a denial we cannot place",
};

/** Render scan results as plain text, one section per agent. */
export function renderAll(results, opts) {
  return results.map((r) => renderText(r, opts)).join("\n");
}

/** Render one agent's scan result as plain text. */
export function renderText(r, { examples = true } = {}) {
  const out = [];
  out.push(`${AGENTS[r.engine].name}, ${count(r.files, "transcript")}, ${count(r.calls, "tool call")}` +
           (r.period.from ? `, ${r.period.from.slice(0, 10)} to ${r.period.to.slice(0, 10)}` : ""));
  out.push("");

  if (!r.refused) {
    out.push("No refused tool calls found.");
  } else {
    out.push(`Refused: ${count(r.refused, "call")} (${n(r.inSubagents)} inside subagents)`);
    const width = Math.max(...Object.keys(LAYER_TEXT).map((k) => k.length));
    for (const [layer, count] of Object.entries(r.byLayer)) {
      if (!count) continue;
      out.push(`  ${layer.padEnd(width)}  ${String(n(count)).padStart(6)}  ${LAYER_TEXT[layer]}${layerNote(r, layer)}`);
    }
    const said = r.byVendorLabel["user-rejected"] ?? 0;
    const labels = [];
    if (said) labels.push(`Claude Code labelled ${n(said)} of these "user-rejected". A person refused ${n(r.byLayer.person)}.`);
    if (r.mislabelled) labels.push(`${count(r.mislabelled, "refusal")} ${agree(r.mislabelled, "carries", "carry")} a vendor label that names the wrong layer.`);
    for (const block of [autoModeLines(r), labels, projectLines(r)]) if (block.length) out.push("", ...block);
  }
  out.push("", ...personLines(r));
  out.push("", `Failed without a refusal: ${count(r.failed, "call")}.`);
  if (r.duplicates) out.push(`${count(r.duplicates, "call")} repeated in more than one transcript ${agree(r.duplicates, "was", "were")} counted once.`);
  if (r.reviews?.requests) out.push("", ...reviewLines(r.reviews));

  if (examples && (r.refused || r.reviews?.requests)) out.push("", "Examples");
  if (!examples && (r.refused || r.reviews?.requests)) {
    out.push("", "Examples are off. --examples 1 shows one per layer with file:line. They quote commands, so check them for secrets before sharing.");
  }
  if (examples && r.refused) {
    for (const [layer, list] of Object.entries(r.examples)) {
      for (const e of list) {
        out.push(`  ${layer}: ${e.tool ?? "?"} ${quote(e.target)}`);
        out.push(`    ${short(e.text)}`);
        out.push(`    ${tilde(e.at)}${e.vendorLabel ? `  [labelled ${e.vendorLabel}]` : ""}`);
      }
    }
  }
  if (examples && r.reviews?.requests) {
    const shown = [["reviewer denied", r.reviews.examples.deny], ["reviewer allowed", r.reviews.examples.unclear]];
    for (const [what, list] of shown) {
      for (const e of list) {
        out.push(`  ${what}: ${e.tool ?? "?"} ${quote(e.target)}`);
        out.push(`    risk ${e.risk}, user authorization ${e.authorization}: ${short(e.text ?? "")}`);
        out.push(`    ${tilde(e.at)}`);
      }
    }
  }

  const advice = Object.entries(r.advice ?? {});
  if (advice.length) {
    out.push("", "What you can do");
    for (const [layer, text] of advice) out.push(`  ${layer}: ${text}`);
  }

  out.push("", "What this record cannot see");
  for (const b of r.blindSpots) out.push(`  - ${b.text}`);
  return out.join("\n") + "\n";
}

const SHOWN_PROJECTS = 5;
const SHOWN_REASONS = 5;

/** Claude Code's auto mode refusals, by what happened. */
const AUTO_MODE = [
  ["cc.classifier-blocked", "blocked by the classifier"],
  ["cc.classifier-unavailable", "the classifier could not answer, so the call was refused without a judgement"],
  ["cc.classifier-safety-check", "a separate safety check refused it over earlier conversation content"],
  ["cc.classifier-interrupted", "a safety classifier stopped it while it ran; it may have completed"],
];

function autoModeLines(r) {
  const rows = AUTO_MODE.filter(([id]) => r.bySignature[id]);
  if (!rows.length) return [];
  const lines = ["Auto mode"];
  for (const [id, text] of rows) {
    lines.push(`  ${String(n(r.bySignature[id])).padStart(6)}  ${text}`);
    if (id === "cc.classifier-blocked") lines.push(...reasonLines(r, r.bySignature[id]));
  }
  return lines;
}

function reasonLines(r, blocked) {
  const row = (c, text) => `          ${String(n(c)).padStart(4)}  ${text}`;
  const reasons = Object.entries(r.classifierReasons).sort((a, b) => b[1] - a[1]);
  const lines = reasons.slice(0, SHOWN_REASONS).map(([why, c]) => row(c, why));
  const rest = reasons.slice(SHOWN_REASONS);
  if (rest.length) lines.push(row(rest.reduce((s, [, c]) => s + c, 0), `${count(rest.length, "other reason")}, in --json`));
  const unnamed = blocked - reasons.reduce((s, [, c]) => s + c, 0);
  if (unnamed) lines.push(row(unnamed, "no reason given"));
  return lines;
}

function personLines(r) {
  if (!r.declaration) {
    return ["Who answers", `  No declaration, so no person is named for any act. See "Who answers" in the README.`];
  }
  const sources = r.declaration.sources.length;
  const lines = [`Who answers (${count(sources, "declaration")})`];
  const person = (id) => [r.declaration.humans[id]?.name ?? id, r.declaration.humans[id]?.role].filter(Boolean).join(", ");
  const rows = [
    ...Object.entries(r.byHuman).sort(([, x], [, y]) => y.calls - x.calls).map(([id, p]) => [person(id), p]),
    ["unaccountable (declared, but no person answers)", r.unaccountable],
    ["undeclared (no declaration covers the directory)", r.undeclared],
  ];
  for (const [who, p] of rows.filter(([, p]) => p.calls)) {
    const alone = p.ranOnReviewerAlone ? `, ${n(p.ranOnReviewerAlone)} ran on the reviewer alone` : "";
    lines.push(`  ${who}: ${count(p.calls, "call")}, ${n(p.refused)} refused${alone}`);
  }
  return lines;
}

function projectLines(r) {
  const withRefusals = Object.entries(r.byRepository).filter(([, p]) => p.refused).sort((a, b) => b[1].refused - a[1].refused);
  if (withRefusals.length < 2) return [];
  const lines = ["By repository"];
  for (const [path, p] of withRefusals.slice(0, SHOWN_PROJECTS)) {
    const mix = Object.entries(p.byLayer).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${n(c)} ${l}`).join(", ");
    const dirs = p.directories > 1 ? `, ${n(p.directories)} directories` : "";
    lines.push(`  ${String(n(p.refused)).padStart(6)} of ${String(n(p.calls)).padStart(6)}  ${tilde(path)}  (${mix}${dirs})`);
  }
  const more = withRefusals.length - SHOWN_PROJECTS;
  if (more > 0) lines.push(`  ${n(more)} more with refusals ${agree(more, "is", "are")} in --json.`);
  return lines;
}

function reviewLines(v) {
  const lines = [`The automatic reviewer judged ${count(v.requests, "approval request")}: ` +
                 `${n(v.allow)} allowed, ${n(v.deny)} denied, ${n(v.noVerdict)} with no verdict.`];
  if (v.ranOnReviewerAlone) lines.push(`${count(v.ranOnReviewerAlone, "act")} ran on the reviewer's allow alone, with no person asked.`);
  if (v.allowedHighRisk || v.allowedWithoutClearAuthorization) {
    lines.push(`Of its allows, it rated ${n(v.allowedHighRisk)} high risk, and for ${n(v.allowedWithoutClearAuthorization)} ` +
               "it rated the user's authorization below high.");
  }
  return lines;
}

function layerNote(r, layer) {
  const asker = (k) => (k === "builtin" ? "asked by built-in checks" : `by ${k}`);
  const parts = layer === "unanswered" ? Object.entries(r.unansweredAskers).map(([k, v]) => `${n(v)} ${asker(k)}`) : [];
  const inferred = r.inferredByLayer[layer];
  if (inferred) parts.push(`${n(inferred)} inferred`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function quote(s) {
  return s ? `"${s.length > 70 ? s.slice(0, 69) + "…" : s}"` : "";
}

function short(s = "") {
  const one = s.replace(/^Error: /, "").replace(/\s+/g, " ");
  return one.length > 110 ? one.slice(0, 109) + "…" : one;
}

function tilde(p) {
  const h = homedir();
  return p === h || p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

/** A copy of `value` with the home directory written as ~ in every string and key. */
export function tildePaths(value) {
  if (typeof value === "string") return tilde(value);
  if (Array.isArray(value)) return value.map(tildePaths);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [tilde(k), tildePaths(v)]));
  }
  return value;
}
