import { LAYERS, loadSignatures } from "./classify.mjs";
import { answererFor } from "./declare.mjs";
import { repoRoot } from "./repo.mjs";
import { agree, count } from "./words.mjs";
import * as claudeCode from "./readers/claude-code.mjs";
import * as codex from "./readers/codex.mjs";

/** One reader per agent. Each knows where its transcripts live and what it cannot see. */
export const AGENTS = { "claude-code": claudeCode, codex };

/** The agent a transcript belongs to, judged by its file name. */
export function agentOf(file) {
  return Object.keys(AGENTS).find((a) => AGENTS[a].owns(file));
}

/**
 * Scan one agent's transcripts and aggregate refusals.
 * `files` defaults to every transcript under the agent's home directory.
 */
export async function scan({ agent = "claude-code", files, home, env = process.env, since = null, examples = 1,
                             declaration = null } = {}) {
  const spec = AGENTS[agent];
  home ??= spec.home(env);
  const table = loadSignatures(spec.table);
  const paths = files ?? spec.find(home);
  const stats = spec.newStats();
  const result = {
    engine: agent,
    files: paths.length,
    calls: 0,
    failed: 0,
    noResult: 0,
    refused: 0,
    byLayer: Object.fromEntries(LAYERS.map((l) => [l, 0])),
    bySignature: {},
    byVendorLabel: dict(),
    mislabelled: 0,
    inferred: 0,
    inferredByLayer: {},
    inSubagents: 0,
    examples: {},
    unansweredAskers: dict(),
    classifierReasons: dict(),
    hookTimeoutsRanUnchecked: 0,
    duplicates: 0,
    byProject: dict(),
    byHuman: dict(),
    undeclared: newRow(),
    unaccountable: newRow(),
    declaration: declaration && { sources: declaration.sources, humans: declaration.humans },
    period: { from: null, to: null },
  };
  const reviews = newReviews();
  const seen = new Set();
  const judged = { acts: [], reviews: [] };

  for (const file of paths) {
    for await (const a of spec.read(file, table, stats)) {
      if (since && a.ts && a.ts < since) continue;
      widen(result.period, a.ts);
      if (a.type === "review") {
        tallyReview(reviews, a, examples);
        judged.reviews.push(a);
        continue;
      }
      if (a.reviewer === "auto_review") judged.acts.push(a);
      if (a.id) {
        if (seen.has(a.id)) {
          result.duplicates++;
          continue;
        }
        seen.add(a.id);
      }
      result.calls++;
      for (const row of [(result.byProject[a.project ?? "(unknown)"] ||= newRow()),
                         answerRow(result, answerer(declaration, agent, a.project))]) {
        row.calls++;
        if (a.outcome === "refused") {
          row.refused++;
          bump(row.byLayer, a.refusal.layer);
        }
      }
      if (a.hookTimedOut && a.outcome !== "refused") result.hookTimeoutsRanUnchecked++;
      if (a.outcome === "failed") result.failed++;
      if (a.outcome === "no-result") result.noResult++;
      if (a.outcome !== "refused") continue;
      tally(result, a, examples);
    }
  }

  const grouped = byRepository(result.byProject);
  result.byRepository = grouped.rows;
  result.ungroupedDirectories = grouped.ungrouped;
  result.malformedLines = stats.malformedLines;
  result.versions = [...stats.versions.keys()].sort(compareVersions);
  result.testedVersions = table.tested;
  result.advice = Object.fromEntries(LAYERS.filter((l) => result.byLayer[l] && table.advice?.[l]).map((l) => [l, table.advice[l]]));
  if (spec.hasReviewer) {
    result.reviews = { ...reviews, ...joinReviews(judged) };
    for (const a of judged.acts.filter((x) => x.ranOnReviewerAlone)) {
      const row = answerRow(result, answerer(declaration, agent, a.project));
      row.ranOnReviewerAlone = (row.ranOnReviewerAlone ?? 0) + 1;
    }
  }
  spec.finish(result, stats, home);
  result.blindSpots = [...spec.blindSpots(result), ...commonBlindSpots(result, table)];
  return result;
}

function tally(r, a, examples) {
  const f = a.refusal;
  r.refused++;
  r.byLayer[f.layer]++;
  if (f.signature) bump(r.bySignature, f.signature);
  if (f.vendorLabel) bump(r.byVendorLabel, f.vendorLabel);
  if (f.mislabelled) r.mislabelled++;
  if (f.inferred) {
    r.inferred++;
    bump(r.inferredByLayer, f.layer);
  }
  if (a.sidechain) r.inSubagents++;
  if (f.layer === "unanswered" && !f.inferred) bump(r.unansweredAskers, f.asker ?? "unknown");
  if (f.layer === "classifier" && f.detail) bump(r.classifierReasons, f.detail);
  const list = (r.examples[f.layer] ||= []);
  if (list.length < examples) {
    list.push({ at: `${a.source.file}:${a.source.line}`, tool: a.tool, target: a.target,
                text: a.text, vendorLabel: f.vendorLabel, sidechain: a.sidechain });
  }
}

/** Who answers for an act: the declaration covering its directory, else its repository's. */
function answerer(declaration, agent, project) {
  if (!declaration) return { declared: false, human: null };
  const own = answererFor(declaration, agent, project);
  return own.declared ? own : answererFor(declaration, agent, repoRoot(project));
}

/** The row an act is counted in: its person's, else unaccountable or undeclared. */
function answerRow(result, who) {
  if (who.human) return (result.byHuman[who.human] ||= newRow());
  return who.declared ? result.unaccountable : result.undeclared;
}

/** Project rows merged per repository; a directory that is gone or outside git keeps its own row. */
function byRepository(byProject) {
  const rows = dict();
  let ungrouped = 0;
  for (const [path, p] of Object.entries(byProject)) {
    const root = repoRoot(path);
    if (!root && path !== "(unknown)") ungrouped++;
    const row = (rows[root ?? path] ||= { calls: 0, refused: 0, byLayer: {}, directories: 0 });
    row.calls += p.calls;
    row.refused += p.refused;
    row.directories++;
    for (const [l, c] of Object.entries(p.byLayer)) row.byLayer[l] = (row.byLayer[l] ?? 0) + c;
  }
  return { rows, ungrouped };
}

function newRow() {
  return { calls: 0, refused: 0, byLayer: {} };
}

function newReviews() {
  return { requests: 0, allow: 0, deny: 0, noVerdict: 0, byRisk: dict(), allowedHighRisk: 0,
           allowedWithoutClearAuthorization: 0, examples: { deny: [], unclear: [] } };
}

function tallyReview(v, r, examples) {
  v.requests++;
  if (r.outcome === "allow") v.allow++;
  else if (r.outcome === "deny") v.deny++;
  else v.noVerdict++;
  if (r.risk) bump(v.byRisk, r.risk);
  if (r.outcome === "deny" && v.examples.deny.length < examples) v.examples.deny.push(reviewExample(r));
  if (r.outcome !== "allow") return;
  if (r.risk === "high") v.allowedHighRisk++;
  if (r.authorization && r.authorization !== "high") {
    v.allowedWithoutClearAuthorization++;
    if (v.examples.unclear.length < examples) v.examples.unclear.push(reviewExample(r));
  }
}

/**
 * Pair each reviewer verdict with the act it judged: same session, same target,
 * the first act at or after the verdict. Unmatched verdicts are counted, not guessed.
 */
function joinReviews({ acts, reviews }) {
  const byKey = new Map();
  for (const a of acts) {
    const k = `${a.session}|${a.target}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(a);
  }
  const out = { matched: 0, ranOnReviewerAlone: 0, ranWithoutClearAuthorization: 0 };
  for (const r of reviews) {
    const list = byKey.get(`${r.parent}|${r.target}`) ?? [];
    const i = list.findIndex((a) => !r.ts || !a.ts || a.ts >= r.ts);
    if (i < 0) continue;
    const [a] = list.splice(i, 1);
    out.matched++;
    if (r.outcome !== "allow" || a.outcome === "refused") continue;
    out.ranOnReviewerAlone++;
    a.ranOnReviewerAlone = true;
    if (r.authorization && r.authorization !== "high") out.ranWithoutClearAuthorization++;
  }
  return out;
}

function reviewExample(r) {
  return { at: `${r.source.file}:${r.source.line}`, tool: r.tool, target: r.target, risk: r.risk,
           authorization: r.authorization, text: r.rationale };
}

/** Blind spots every agent shares. Each reader adds its own first. */
export function commonBlindSpots(r, table) {
  const out = [];
  if (r.hookTimeoutsRanUnchecked) {
    out.push({ id: "hook-timeout",
               text: `${count(r.hookTimeoutsRanUnchecked, "tool call")} ran after a PreToolUse hook timed out, so no hook checked them.` });
  }
  if (r.noResult) {
    out.push({ id: "no-result", text: `${count(r.noResult, "tool call")} ${agree(r.noResult, "has", "have")} no recorded result.` });
  }
  for (const sig of table.signatures.filter((s) => s.inferred && r.bySignature[s.id])) {
    out.push({ id: `inferred:${sig.id}`,
               text: `${count(r.bySignature[sig.id], "refusal")} ${agree(r.bySignature[sig.id], "is", "are")} counted as ${sig.layer} by inference: ${sig.why}.` });
  }
  if (r.ungroupedDirectories) {
    out.push({ id: "ungrouped", text: `${count(r.ungroupedDirectories, "working directory", "working directories")} ${agree(r.ungroupedDirectories, "is", "are")} gone or outside git, ` +
                                      "so they are shown by path, not by repository. Declare their parent path to name who answers for them." });
  }
  if (r.byLayer.unknown) {
    out.push({ id: "unknown", text: `${count(r.byLayer.unknown, "refusal")} ${agree(r.byLayer.unknown, "carries", "carry")} a denial label this version cannot place.` });
  }
  const untested = r.versions.filter((v) => !inRange(v, r.testedVersions));
  out.push({
    id: "format",
    text: "The transcript format is undocumented and changes between versions. " +
          `Tested on ${r.testedVersions.join(" to ")}.` +
          (untested.length ? ` Seen but untested: ${untested.join(", ")}.` : ""),
  });
  if (r.malformedLines) out.push({ id: "malformed", text: `${count(r.malformedLines, "line")} could not be parsed and ${agree(r.malformedLines, "was", "were")} skipped.` });
  out.push({ id: "model-declined", text: "A model that declines before calling a tool leaves no refusal to count." });
  out.push({ id: "text-only", text: "Layers other than the vendor's label are inferred from message text, not from a documented field." });
  return out;
}

function widen(period, ts) {
  if (typeof ts !== "string") return;
  if (!period.from || ts < period.from) period.from = ts;
  if (!period.to || ts > period.to) period.to = ts;
}

/** A map for keys read from transcripts, where "__proto__" is just a key. */
function dict() {
  return Object.create(null);
}

function bump(obj, k) {
  obj[k] = (obj[k] ?? 0) + 1;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function inRange(v, [lo, hi]) {
  return compareVersions(v, lo) >= 0 && compareVersions(v, hi) <= 0;
}
