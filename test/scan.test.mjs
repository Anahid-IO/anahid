import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDeclarations } from "../src/declare.mjs";
import { tildePaths } from "../src/report.mjs";
import { scan } from "../src/scan.mjs";

const BIN = new URL("../bin/anahid.mjs", import.meta.url).pathname;
const NO_CODEX = mkdtempSync(join(tmpdir(), "anahid-nocodex-"));

function call(id, command, { ts = "2026-09-20T10:00:00Z", sidechain = false, cwd = "/repo" } = {}) {
  return { type: "assistant", sessionId: "s1", cwd, version: "2.1.280", isSidechain: sidechain, timestamp: ts,
           message: { content: [{ type: "tool_use", id, name: "Bash", input: { command } }] } };
}

function result(id, text, { isError = true, denialKind, ts = "2026-09-20T10:00:01Z", sidechain = false } = {}) {
  const r = { type: "user", sessionId: "s1", version: "2.1.280", isSidechain: sidechain, timestamp: ts,
              message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] } };
  if (denialKind) r.toolDenialKind = denialKind;
  return r;
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "anahid-scan-"));
  const project = join(home, "projects", "-repo");
  mkdirSync(join(project, "s1", "subagents"), { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ cleanupPeriodDays: 14 }));
  const main = [
    call("t1", "ls"), result("t1", "a b", { isError: false }),
    call("t2", "rm -rf /"), result("t2", "The user doesn't want to proceed with this tool use.", { denialKind: "user-rejected" }),
    call("t3", "make"), result("t3", "Exit code 2"),
    { type: "attachment", attachment: { type: "hook_cancelled", hookEvent: "PreToolUse", hookName: "PreToolUse:Bash",
                                        toolUseID: "t4", timedOut: true } },
    call("t4", "curl x"), result("t4", "ok", { isError: false }),
    call("t5", "sleep 9"),
    call("t0", "old", { ts: "2026-08-01T00:00:00Z" }), result("t0", "old", { isError: false, ts: "2026-08-01T00:00:01Z" }),
  ];
  const sub = [
    call("u1", "pnpm -v && ls", { sidechain: true, cwd: "/repo/worktree" }),
    result("u1", "This Bash command contains multiple operations. The following part requires approval: pnpm -v",
           { denialKind: "user-rejected", sidechain: true }),
  ];
  const text = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(project, "s1.jsonl"), text(main) + "{not json\n");
  writeFileSync(join(project, "s1", "subagents", "agent-a.jsonl"), text(sub));
  return home;
}

test("scan pairs calls with results and places each refusal", async () => {
  const r = await scan({ home: fixture() });
  assert.equal(r.files, 2);
  assert.equal(r.calls, 7);
  assert.equal(r.refused, 2);
  assert.equal(r.byLayer.person, 1);
  assert.equal(r.byLayer.unanswered, 1);
  assert.equal(r.unansweredAskers.builtin, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.noResult, 1);
  assert.equal(r.inSubagents, 1);
  assert.equal(r.mislabelled, 1);
  assert.equal(r.byVendorLabel["user-rejected"], 2);
  assert.equal(r.hookTimeoutsRanUnchecked, 1);
  assert.equal(r.malformedLines, 1);
});

test("refusals are counted per project, and advice is given only for layers that refused", async () => {
  const r = await scan({ home: fixture() });
  assert.deepEqual(r.byProject["/repo"], { calls: 6, refused: 1, byLayer: { person: 1 } });
  assert.deepEqual(r.byProject["/repo/worktree"], { calls: 1, refused: 1, byLayer: { unanswered: 1 } });
  assert.deepEqual(Object.keys(r.advice), ["unanswered"]);
});

test("the text report shows projects and what to do", () => {
  const out = execFileSync("node", [BIN], { env: { ...process.env, CLAUDE_CONFIG_DIR: fixture(), CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  assert.match(out, /By repository\n +1 of +6 +\/repo +\(1 person\)\n +1 of +1 +\/repo\/worktree +\(1 unanswered\)/);
  assert.match(out, /What you can do\n  unanswered: Approval was asked where nobody could answer/);
});

test("worktrees of one repository are one row, and a declaration on the checkout covers them", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "anahid-repo-")));
  const main = join(root, "main");
  const git = (...a) => execFileSync("git", a, { cwd: main, stdio: "ignore" });
  mkdirSync(main);
  git("init", "-q");
  git("-c", "user.email=s@s", "-c", "user.name=s", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", join(root, "wt"));
  const home = mkdtempSync(join(tmpdir(), "anahid-scan-"));
  mkdirSync(join(home, "projects", "-r"), { recursive: true });
  const recs = [call("m1", "ls", { cwd: main }), result("m1", "ok", { isError: false }),
                call("w1", "rm x", { cwd: join(root, "wt") }), result("w1", "Permission to use Bash with command rm x has been denied.", { denialKind: "permission-rule" })];
  writeFileSync(join(home, "projects", "-r", "s.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const decl = join(root, "declaration.json");
  writeFileSync(decl, JSON.stringify({ schema: "anahid.declaration/3", humans: { alice: {} }, agents: { cc: { owner: "alice" } },
                                       sources: { hooks: { kind: "claude-code-hooks", agent: "cc", path: main } } }));
  const r = await scan({ home, declaration: loadDeclarations([decl]) });
  assert.deepEqual(r.byRepository[main], { calls: 2, refused: 1, byLayer: { rule: 1 }, directories: 2 });
  assert.equal(r.ungroupedDirectories, 0);
  assert.equal(r.byHuman.alice.calls, 2, "the worktree is answered for through its repository");
  assert.equal(r.unaccountable.calls, 0);
  assert.equal(r.undeclared.calls, 0);
});

test("a call copied into a resumed session is counted once", async () => {
  const home = fixture();
  const copy = [call("t2", "rm -rf /"), result("t2", "The user doesn't want to proceed with this tool use.", { denialKind: "user-rejected" })];
  writeFileSync(join(home, "projects", "-repo", "s2.jsonl"), copy.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await scan({ home });
  assert.equal(r.calls, 7);
  assert.equal(r.byLayer.person, 1);
  assert.equal(r.duplicates, 1);
});

test("blind spots name retention, timeouts, missing results and parse failures", async () => {
  const r = await scan({ home: fixture() });
  const ids = r.blindSpots.map((b) => b.id);
  assert.deepEqual(ids, ["retention", "hook-timeout", "no-result", "ungrouped", "format", "malformed", "model-declined", "text-only"]);
  assert.match(r.blindSpots[0].text, /after 14 days \(settings\.json\)/);
});

test("a call a safety classifier cut off mid-run is a classifier refusal that may have completed", async () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-cut-"));
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  const text = "Interrupted: the response that made this tool call was stopped by a safety classifier while the call was running; " +
               "it may have partially or fully completed.";
  const recs = [call("t1", "ls"), result("t1", text, { denialKind: "interrupted" })];
  writeFileSync(join(home, "projects", "p", "s.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = await scan({ home });
  assert.equal(r.byLayer.classifier, 1);
  assert.equal(r.mislabelled, 1);
  assert.match(r.blindSpots.find((b) => b.id === "cut-mid-run").text, /^1 refused call was stopped .* may have partly or fully completed\.$/);
});

test("the report splits auto mode refusals by what happened, with the block reasons", () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-auto-"));
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  const blocked = (why) => `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${why}. If you have other tasks`;
  const recs = [
    call("t1", "a"), result("t1", blocked("[Git Destructive]"), { denialKind: "automode-blocked" }),
    call("t2", "b"), result("t2", blocked("[Git Destructive]"), { denialKind: "automode-blocked" }),
    call("t3", "c"), result("t3", blocked("Blocked by classifier"), { denialKind: "automode-blocked" }),
    call("t4", "d"), result("t4", "Auto mode could not evaluate this action and is blocking it for safety.", { denialKind: "automode-unavailable" }),
  ];
  writeFileSync(join(home, "projects", "p", "s.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const out = execFileSync("node", [BIN], { env: { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  assert.match(out, /Auto mode\n +3  blocked by the classifier\n +2  Git Destructive\n +1  no reason given\n +1  the classifier could not answer/);
});

test("--since drops earlier calls", async () => {
  const r = await scan({ home: fixture(), since: "2026-09-01T00:00:00Z" });
  assert.equal(r.calls, 6);
  assert.equal(r.period.from, "2026-09-20T10:00:00Z");
});

test("the CLI prints the headline and exits 0", () => {
  const home = fixture();
  const out = execFileSync("node", [BIN], { env: { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  assert.match(out, /Claude Code labelled 2 of these "user-rejected"\. A person refused 1\./);
  assert.match(out, /What this record cannot see/);
});

test("the CLI emits versioned JSON", () => {
  const home = fixture();
  const out = execFileSync("node", [BIN, "--json"], { env: { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  const j = JSON.parse(out);
  assert.equal(j.schema, "anahid.refusals/1");
  assert.deepEqual(j.reports.map((r) => r.engine), ["claude-code"]);
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.deepEqual(j.generator, { name: "anahid", version });
  assert.ok(!Number.isNaN(Date.parse(j.generatedAt)));
  assert.deepEqual(j.arguments, ["--json"]);
});

test("--fail-on exits 1 when a named layer refused, or when nothing was scanned", () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fixture(), CODEX_HOME: NO_CODEX };
  const hit = spawnSync("node", [BIN, "--fail-on", "sandbox,person"], { env, encoding: "utf8" });
  assert.equal(hit.status, 1);
  assert.equal(hit.stderr, "--fail-on: 1 person\n");
  assert.match(hit.stdout, /^Claude Code, /);
  assert.equal(spawnSync("node", [BIN, "--fail-on", "sandbox"], { env, encoding: "utf8" }).status, 0);
  const empty = { ...env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "anahid-empty-")) };
  const none = spawnSync("node", [BIN, "--fail-on", "person"], { env: empty, encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^No transcripts found under .*\n--fail-on: no tool calls were scanned\n$/);
  for (const bad of ["bogus", ","]) assert.equal(spawnSync("node", [BIN, "--fail-on", bad], { env, encoding: "utf8" }).status, 2);
});

test("an empty machine is told where the tool looked", () => {
  const empty = mkdtempSync(join(tmpdir(), "anahid-none-"));
  const r = spawnSync("node", [BIN], { env: { ...process.env, CLAUDE_CONFIG_DIR: empty, CODEX_HOME: empty }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, `No transcripts found under ${empty} or ${empty}.\n`);
});

test("a scan that fails exits 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "anahid-crash-"));
  const notAFile = join(dir, "s.jsonl");
  mkdirSync(notAFile);
  const r = spawnSync("node", [BIN, notAFile], { env: { ...process.env, CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /^anahid: /);
});

test("the CLI rejects bad arguments with exit 2", () => {
  const claudeFile = join(mkdtempSync(join(tmpdir(), "anahid-args-")), "s.jsonl");
  writeFileSync(claudeFile, "");
  for (const args of [["bogus"], ["--examples", "x"], ["--since", "yesterday-ish"], ["--engine", "cursor"],
                      ["--engine", "codex", claudeFile], ["--agent", "codex"]]) {
    const r = spawnSync("node", [BIN, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
  }
});

test("a missing transcript is named plainly with exit 2", () => {
  const r = spawnSync("node", [BIN, "/nonexistent/s.jsonl"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "/nonexistent/s.jsonl: no such file\n");
});

test("--version prints the package version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
  assert.equal(execFileSync("node", [BIN, "--version"], { encoding: "utf8" }), `${version}\n`);
});

test("terminal control characters in transcripts are printed as escapes", () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-esc-"));
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  const recs = [call("t1", "ls \u001b]0;owned\u0007"), result("t1", "Hook said \u001b[2J no", { denialKind: "permission-rule" })];
  writeFileSync(join(home, "projects", "p", "s.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const out = execFileSync("node", [BIN, "--examples", "1"], { env: { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: NO_CODEX }, encoding: "utf8" });
  assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  assert.match(out, /\\u001b\]0;owned\\u0007/);
  assert.match(out, /1 transcript, 2 tool calls|1 transcript, 1 tool call/);
});

test("keys taken from transcripts cannot reach Object.prototype", async () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-proto-"));
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  const recs = [
    call("t1", "ls", { cwd: "__proto__" }), result("t1", "no", { denialKind: "constructor" }),
    call("t2", "ls", { cwd: "constructor" }), result("t2", "The user doesn't want to proceed with this tool use.", { denialKind: "__proto__" }),
  ];
  writeFileSync(join(home, "projects", "p", "s.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = await scan({ home });
  assert.equal(r.refused, 2);
  assert.equal(r.byProject["__proto__"].calls, 1);
  assert.equal(r.byProject["constructor"].refused, 1);
  assert.equal(r.byVendorLabel["__proto__"], 1);
  assert.equal({}.calls, undefined);
  assert.equal({}.refused, undefined);
});

test("terminal control sequences in transcripts are printed as escapes", () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-ansi-"));
  mkdirSync(join(home, "projects", "p"), { recursive: true });
  const recs = [
    call("t1", "echo \u001b]0;owned\u0007 \u202eevil", { cwd: "/repo\u001b[2J" }),
    result("t1", "The user doesn't want to proceed \u009b31m with this tool use.", { denialKind: "user-rejected" }),
  ];
  writeFileSync(join(home, "projects", "p", "s.jsonl"), recs.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, CODEX_HOME: NO_CODEX };
  const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/;
  const text = execFileSync("node", [BIN, "--examples", "1"], { env, encoding: "utf8" });
  assert.doesNotMatch(text, unsafe);
  assert.match(text, /echo \\u001b\]0;owned\\u0007 \\u202eevil/);
  const json = execFileSync("node", [BIN, "--json", "--examples", "1"], { env, encoding: "utf8" });
  assert.doesNotMatch(json, unsafe);
  assert.equal(JSON.parse(json).reports[0].refused, 1);
});

test("the default report quotes no command and says how to see examples", () => {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fixture(), CODEX_HOME: NO_CODEX };
  const text = execFileSync("node", [BIN], { env, encoding: "utf8" });
  assert.doesNotMatch(text, /rm -rf/);
  assert.match(text, /Examples are off\. --examples 1 shows one per layer/);
  assert.doesNotMatch(execFileSync("node", [BIN, "--json"], { env, encoding: "utf8" }), /rm -rf/);
  assert.match(execFileSync("node", [BIN, "--examples", "1"], { env, encoding: "utf8" }), /rm -rf/);
});

test("JSON paths under the home directory are written with ~, in keys and values", () => {
  const h = homedir();
  const out = tildePaths({ [`${h}/code`]: { source: `${h}/.claude/p/s.jsonl:3`, other: `${h}2/x`, n: 1 }, list: [h] });
  assert.deepEqual(out, { "~/code": { source: "~/.claude/p/s.jsonl:3", other: `${h}2/x`, n: 1 }, list: ["~"] });
});
