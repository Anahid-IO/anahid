#!/usr/bin/env node
// Run the scenarios against the real agent CLIs, then run anahid on what they
// left on disk. Costs model tokens; not part of `npm test`.
//
//   node sim/run.mjs                 every scenario
//   node sim/run.mjs cc-rule cx-...  only these
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { findJsonl } from "../src/files.mjs";
import { scenarios } from "./scenarios.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = join(ROOT, "bin/anahid.mjs");
const TIMEOUT_MS = 240_000;
const CLAUDE_MODEL = process.env.SIM_CLAUDE_MODEL || "haiku";

const only = process.argv.slice(2);
const chosen = only.length ? scenarios.filter((s) => only.includes(s.id)) : scenarios;
const base = realpathSync(mkdtempSync(join(tmpdir(), "anahid-sim-")));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_?CODE|^CLAUDECODE/.test(k)));

const results = [];
for (const s of chosen) {
  process.stderr.write(`${s.id} ... `);
  const r = run(s);
  results.push(r);
  process.stderr.write(`${r.verdict}\n`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = join(ROOT, "sim/results");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `${stamp}.json`), JSON.stringify({ versions: versions(), results }, null, 2) + "\n");
writeFileSync(join(out, `${stamp}.md`), summary(results));
process.stdout.write(summary(results));

function run(s) {
  const dir = join(base, s.id);
  mkdirSync(dir);
  for (const cmd of s.setup ?? []) execFileSync("sh", ["-c", cmd], { cwd: dir });
  const started = Date.now();
  const cwd = s.cwd ? realpathSync(join(dir, s.cwd)) : dir;
  const agent = s.agent === "claude-code" ? runClaude(s, cwd) : runCodex(s, cwd);
  const files = keep(s.agent === "claude-code" ? claudeFiles(agent.session) : codexFiles(cwd, started), dir);
  const head = { id: s.id, agent: s.agent, what: s.what, dir, exit: agent.status, seconds: Math.round((Date.now() - started) / 1000),
                 files: files.map((f) => f.replace(homedir(), "~")) };
  if (!files.length) return { ...head, verdict: "no-transcript", stderr: agent.stderr?.slice(-500) };
  const anahid = (extra = []) => JSON.parse(execFileSync("node", [BIN, "--json", "--examples", "5", ...extra, ...files],
                                                      { encoding: "utf8", env: { ...process.env, ANAHID_HOME: dir } }))
    .reports.find((r) => r.engine === s.agent);
  const report = anahid(s.declaration ? ["--declaration", declarationFor(s, dir)] : []);
  if (report && s.declaration) report.undeclaredWithout = anahid().undeclared.calls;
  if (report) report.mainCheckout = dir;
  if (!report) return { ...head, verdict: "error", stderr: `anahid gave no ${s.agent} report for these files` };
  report.failOnExit = Object.fromEntries(s.expect.filter((e) => e.failOn).map((e) =>
    [e.failOn, spawnSync("node", [BIN, "--fail-on", e.failOn, ...files], { encoding: "utf8", env: { ...process.env, ANAHID_HOME: dir } }).status]));
  const checks = s.expect.map((e) => ({ expect: e, ok: holds(e, report) }));
  return {
    ...head,
    verdict: checks.every((c) => c.ok) ? "pass" : s.observe ? "observed" : "miss",
    checks,
    observed: {
      calls: report.calls, refused: report.refused, failed: report.failed,
      bySignature: report.bySignature, byVendorLabel: report.byVendorLabel, inSubagents: report.inSubagents,
      hookTimeoutsRanUnchecked: report.hookTimeoutsRanUnchecked, sandboxSuspects: report.sandboxSuspects,
      reviews: report.reviews && { requests: report.reviews.requests, allow: report.reviews.allow, deny: report.reviews.deny,
                                   matched: report.reviews.matched, ranOnReviewerAlone: report.reviews.ranOnReviewerAlone },
      texts: Object.values(report.examples).flat().map((e) => `${e.vendorLabel ?? "-"} | ${e.text}`),
    },
  };
}

/** An anahid.declaration/3 whose agent for the scenario's engine is owned by its person, bound to its workspace. */
function declarationFor(s, dir) {
  const file = join(dir, ".sim-declaration.json");
  const kind = s.agent === "claude-code" ? "claude-code-hooks" : "codex-hooks";
  writeFileSync(file, JSON.stringify({ schema: "anahid.declaration/3", humans: s.declaration.humans,
                                       agents: { agent: { owner: s.declaration.owner, parent: null } },
                                       sources: { hooks: { kind, agent: "agent", path: dir } } }));
  return file;
}

function runClaude(s, dir) {
  const session = randomUUID();
  const settings = join(dir, ".sim-settings.json");
  writeFileSync(settings, JSON.stringify(s.settings ?? {}));
  const args = ["-p", s.prompt, "--model", s.model ?? CLAUDE_MODEL, "--session-id", session, "--setting-sources", "project",
                "--settings", settings, "--permission-prompts", s.prompts ?? "none", "--output-format", "json"];
  if (s.mode) args.push("--permission-mode", s.mode);
  if (s.promptTool) {
    const mcp = { mcpServers: { sim: { command: "node", args: [join(ROOT, "sim/prompt-tool.mjs")],
                                       env: { SIM_BEHAVIOR: s.promptTool.behavior, SIM_MESSAGE: s.promptTool.message ?? "" } } } };
    writeFileSync(join(dir, ".sim-mcp.json"), JSON.stringify(mcp));
    args.push("--mcp-config", join(dir, ".sim-mcp.json"), "--strict-mcp-config",
              "--permission-prompt-tool", "mcp__sim__decide");
    args.splice(args.indexOf("--permission-prompts"), 2);
  }
  const p = spawnSync("claude", args, { cwd: dir, env, encoding: "utf8", timeout: TIMEOUT_MS });
  return { session, status: p.status, stderr: p.stderr };
}

function runCodex(s, dir) {
  const args = ["exec", "--skip-git-repo-check", ...(s.userConfig ? [] : ["--ignore-user-config"]), "-C", dir, "-s", s.sandbox];
  for (const [k, v] of Object.entries(s.config ?? {})) args.push("-c", `${k}=${JSON.stringify(v)}`);
  args.push(s.prompt);
  const p = spawnSync("codex", args, { cwd: dir, env, encoding: "utf8", timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] });
  return { status: p.status, stderr: p.stderr };
}

/** Move a run's transcripts out of the user's real history, so later reports are not polluted by simulations. */
function keep(files, dir) {
  return files.map((f, i) => {
    const to = join(dir, ".transcripts", String(i), basename(f));
    mkdirSync(join(dir, ".transcripts", String(i)), { recursive: true });
    cpSync(f, to);
    rmSync(f);
    return to;
  });
}

function claudeFiles(session) {
  const home = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return findJsonl(join(home, "projects")).filter((f) => f.includes(session));
}

function codexFiles(dir, since) {
  const home = process.env.CODEX_HOME || join(homedir(), ".codex");
  return findJsonl(join(home, "sessions")).filter((f) => {
    if (!basename(f).startsWith("rollout-") || statSync(f).mtimeMs < since) return false;
    try {
      const meta = JSON.parse(readFileSync(f, "utf8").split("\n", 1)[0]).payload;
      return meta?.cwd && realpathSync(meta.cwd) === dir;
    } catch {
      return false;
    }
  });
}

function holds(e, r) {
  if (e.anyOf) return e.anyOf.some((x) => holds(x, r));
  if (e.signature) return (r.bySignature[e.signature] ?? 0) > 0;
  if (e.layer) return r.byLayer[e.layer] > 0;
  if (e.notLayer) return r.byLayer[e.notLayer] === 0;
  if (e.vendorLabel) return (r.byVendorLabel[e.vendorLabel] ?? 0) > 0;
  if (e.mislabelled) return r.mislabelled > 0;
  if (e.refused) return r.refused >= e.refused;
  if (e.reviews) return (r.reviews?.requests ?? 0) >= e.reviews;
  if (e.repository) return Boolean(r.byRepository[r.mainCheckout]);
  if (e.person) return (r.byHuman[e.person]?.ranOnReviewerAlone ?? 0) >= e.ranOnReviewerAlone;
  if ("undeclared" in e) return r.undeclared.calls === e.undeclared;
  if ("unaccountable" in e) return r.unaccountable.calls === e.unaccountable;
  if (e.undeclaredWithout) return r.undeclaredWithout >= e.undeclaredWithout;
  if (e.joined) return (r.reviews?.matched ?? 0) >= e.joined;
  if (e.ranOnReviewerAlone) return (r.reviews?.ranOnReviewerAlone ?? 0) >= e.ranOnReviewerAlone;
  if (e.stat) return (r[e.stat] ?? 0) >= e.min;
  if (e.failOn) return r.failOnExit[e.failOn] === e.exit;
  return false;
}

function versions() {
  const v = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).stdout.trim();
  return { claude: v("claude"), codex: v("codex"), claudeModel: CLAUDE_MODEL };
}

function summary(rs) {
  const lines = [`# Simulation ${new Date().toISOString().slice(0, 16)}Z`, "", `${JSON.stringify(versions())}`, "",
                 "| scenario | verdict | refused | signatures | vendor labels |", "|---|---|---|---|---|"];
  for (const r of rs) {
    const o = r.observed ?? {};
    lines.push(`| ${r.id} | ${r.verdict} | ${o.refused ?? "-"} | ${JSON.stringify(o.bySignature ?? {})} | ${JSON.stringify(o.byVendorLabel ?? {})} |`);
  }
  lines.push("", "## What each run left", "");
  for (const r of rs) {
    lines.push(`### ${r.id}: ${r.verdict}`, "", r.what, "");
    for (const c of r.checks ?? []) lines.push(`- ${c.ok ? "held" : "did not hold"}: \`${JSON.stringify(c.expect)}\``);
    for (const t of r.observed?.texts ?? []) lines.push(`- text: ${t.replace(/\s+/g, " ").slice(0, 220)}`);
    if (r.observed?.reviews) lines.push(`- reviews: ${JSON.stringify(r.observed.reviews)}`);
    if (r.stderr) lines.push(`- stderr: ${r.stderr.replace(/\s+/g, " ").slice(0, 300)}`);
    lines.push("");
  }
  return lines.join("\n");
}
