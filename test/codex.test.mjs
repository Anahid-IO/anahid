import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scan } from "../src/scan.mjs";

const BIN = new URL("../bin/anahid.mjs", import.meta.url).pathname;
const TS = "2026-09-20T10:00:00Z";

const rec = (type, payload, ts = TS) => ({ timestamp: ts, type, payload });
const meta = (id, extra = {}) => rec("session_meta", { id, cwd: "/repo", cli_version: "0.150.1", source: "cli", ...extra });
const turn = (reviewer, sandbox = "workspace-write") =>
  rec("turn_context", { cwd: "/repo", approval_policy: "on-request", approvals_reviewer: reviewer, sandbox_policy: { type: sandbox } });
const item = (it) => rec("event_msg", { type: "item_completed", item: it });
const command = (cmd, status, output = "") =>
  item({ type: "CommandExecution", command: ["/bin/zsh", "-lc", cmd], status, aggregated_output: output });

// Codex writes the refusal as Rust Debug output inside a string, so the reason is escaped twice.
const rejectedOutput = (cmd, reason) => rec("response_item", {
  type: "custom_tool_call_output", call_id: "c1",
  output: [{ type: "input_text", text: "Script error:\n" +
    `exec_command failed for \`${cmd}\`: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\\\nReason: ${reason}\\")" }` }],
});

const request = (cmd) => rec("response_item", { type: "message", role: "user", content: [
  { type: "input_text", text: ">>> APPROVAL REQUEST START\n" },
  { type: "input_text", text: "Planned action JSON:\n" },
  { type: "input_text", text: JSON.stringify({ tool: "exec_command", command: ["/bin/zsh", "-lc", cmd] }) + "\n" },
  { type: "input_text", text: ">>> APPROVAL REQUEST END\n" },
] });
const verdict = (outcome, risk, authorization) => rec("event_msg", {
  type: "task_complete",
  last_agent_message: JSON.stringify({ risk_level: risk, user_authorization: authorization, outcome, rationale: `${outcome} it` }),
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "anahid-codex-"));
  const day = join(home, "sessions", "2026", "09", "20");
  mkdirSync(day, { recursive: true });
  const main = [
    meta("t1"),
    turn("auto_review"),
    command("ls", "completed", "a b"),
    command("touch /etc/x", "failed", "touch: /etc/x: Operation not permitted"),
    command("make", "failed", "Exit code 2"),
    item({ type: "FileChange", status: "declined", changes: { "/repo/a.css": {} },
           stderr: "The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe." }),
    rejectedOutput("git push origin dev", "Pushing exports private code."),
    item({ type: "CommandExecution", command: ["/bin/zsh", "-lc", "rm x"], status: "blocked", aggregated_output: "no" }),
    rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c3",
                           input: 'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: /repo/notes.txt\\n+hi\\n*** End Patch"));' }),
    rec("response_item", { type: "custom_tool_call_output", call_id: "c3", output: [
      { type: "input_text", text: "Script error:\npatch rejected: writing is blocked by read-only sandbox; rejected by user approval settings" }] }),
    rec("response_item", { type: "function_call_output", call_id: "c2", output:
      'exec_command failed for `cargo run`: CreateProcess { message: "Spawn(\\"No such file\\")" }' }),
    item({ type: "Reasoning" }),
    turn("user"),
    command("pwd", "completed"),
  ];
  const guardian = [
    meta("g1", { source: { subagent: { other: "guardian" } }, thread_source: "guardian_review", parent_thread_id: "t1" }),
    turn("user", "read-only"),
    request("git commit -m x"), verdict("allow", "medium", "medium"),
    request("git push origin dev"), verdict("deny", "high", "low"),
    request("docker build ."), rec("event_msg", { type: "turn_aborted", reason: "interrupted" }),
  ];
  const text = (recs) => recs.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(day, "rollout-2026-09-20T10-00-00-t1.jsonl"), text(main) + "{not json\n");
  writeFileSync(join(day, "rollout-2026-09-20T10-00-01-g1.jsonl"), text(guardian));
  return home;
}

test("codex: items, text-only refusals and reviewer verdicts", async () => {
  const r = await scan({ agent: "codex", home: fixture() });
  assert.equal(r.files, 2);
  assert.equal(r.calls, 9);
  assert.equal(r.failed, 3);
  assert.equal(r.refused, 4);
  assert.equal(r.byLayer.classifier, 2);
  assert.equal(r.byLayer.sandbox, 1);
  assert.equal(r.byLayer.unknown, 1);
  assert.equal(r.mislabelled, 1);
  assert.equal(r.examples.sandbox[0].target, "/repo/notes.txt");
  assert.equal(r.unreadExecErrors, 1);
  assert.deepEqual(r.bySignature, { "cx.reviewer-timeout": 1, "cx.reviewer-denied": 1, "cx.sandbox": 1 });
  assert.equal(r.examples.classifier[0].tool, "apply_patch");
  assert.equal(r.sandboxSuspects, 1);
  assert.equal(r.personReviewedTurns, 1);
  assert.equal(r.malformedLines, 1);
  const v = r.reviews;
  assert.deepEqual([v.requests, v.allow, v.deny, v.noVerdict], [3, 1, 1, 1]);
  assert.equal(v.allowedWithoutClearAuthorization, 1);
  assert.equal(v.matched, 1, "the denied push is paired with its refused act");
  assert.equal(v.ranOnReviewerAlone, 0);
  assert.equal(v.examples.deny[0].target, "git push origin dev");
});

test("codex: the reason is unescaped twice", async () => {
  const r = await scan({ agent: "codex", home: fixture(), examples: 5 });
  const [push] = r.examples.classifier.filter((e) => e.tool === "exec_command");
  assert.equal(push.target, "git push origin dev");
  assert.equal(push.text, "This action was rejected due to unacceptable risk.\nReason: Pushing exports private code.");
});

test("codex: blind spots name person decisions, sandbox errors and missing verdicts", async () => {
  const r = await scan({ agent: "codex", home: fixture() });
  const ids = r.blindSpots.map((b) => b.id);
  assert.deepEqual(ids, ["retention", "person-decisions", "no-refusal-field", "sandbox-eperm", "review-unmatched", "review-no-verdict", "ungrouped", "unknown",
                         "format", "malformed", "model-declined", "text-only"]);
});

test("codex: with no item events, commands are read from the exec script's output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "anahid-codex-exec-"));
  const file = join(dir, "rollout-2026-09-26T10-00-00-e1.jsonl");
  const recs = [
    meta("e1", { originator: "codex_exec" }),
    turn("user", "read-only"),
    rec("response_item", { type: "custom_tool_call", name: "exec", call_id: "c1",
                           input: 'text(await tools.exec_command({cmd:"touch a.txt"}));' }),
    rec("response_item", { type: "custom_tool_call_output", call_id: "c1", output: [
      { type: "input_text", text: "Script completed\nOutput:\n" },
      { type: "input_text", text: JSON.stringify({ chunk_id: "1", exit_code: 1, output: "touch: a.txt: Operation not permitted\n" }) },
    ] }),
  ];
  writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await scan({ agent: "codex", files: [file] });
  assert.equal(r.calls, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.sandboxSuspects, 1);
});

test("the CLI reports both agents when both have transcripts", () => {
  const claude = mkdtempSync(join(tmpdir(), "anahid-cc-"));
  mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
  writeFileSync(join(claude, "projects", "-repo", "s.jsonl"), "");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: fixture() };
  const out = execFileSync("node", [BIN], { env, encoding: "utf8" });
  assert.match(out, /^Claude Code, 1 transcript,/m);
  assert.match(out, /^Codex, 2 transcripts, 9 tool calls/m);
  assert.match(out, /The automatic reviewer judged 3 approval requests: 1 allowed, 1 denied, 1 with no verdict\./);
  const only = JSON.parse(execFileSync("node", [BIN, "--engine", "codex", "--json"], { env, encoding: "utf8" }));
  assert.deepEqual(only.reports.map((r) => r.engine), ["codex"]);
});

test("the JSON schema names exactly the fields a report carries", async () => {
  const schema = JSON.parse(readFileSync(new URL("../spec/refusals.schema.json", import.meta.url), "utf8"));
  const known = Object.keys(schema.$defs.report.properties);
  const codex = await scan({ agent: "codex", home: fixture() });
  const claude = await scan({ agent: "claude-code", home: "/nonexistent" });
  const seen = new Set([...Object.keys(codex), ...Object.keys(claude)]);
  assert.deepEqual([...seen].filter((k) => !known.includes(k)), []);
  assert.deepEqual(known.filter((k) => !seen.has(k)), []);
  for (const r of [codex, claude]) {
    assert.deepEqual(schema.$defs.report.required.filter((k) => !(k in r)), []);
  }
});

test("codex: item types and denial labels read from rollouts cannot reach Object.prototype", async () => {
  const home = mkdtempSync(join(tmpdir(), "anahid-codex-proto-"));
  const day = join(home, "sessions", "2026", "09", "20");
  mkdirSync(day, { recursive: true });
  const recs = [meta("p1"), turn("user"), item({ type: "constructor" }), item({ type: "__proto__" }),
                item({ type: "hasOwnProperty" }), command("ls", "completed", "a")];
  writeFileSync(join(day, "rollout-2026-09-20T10-00-00-p1.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const r = await scan({ agent: "codex", home });
  assert.equal(r.calls, 1);
});
