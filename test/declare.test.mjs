import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { answererFor, loadDeclarations } from "../src/declare.mjs";

const BIN = new URL("../bin/anahid.mjs", import.meta.url).pathname;

/** One anahid.declaration/3 per project, as the Anahid product stores it. */
function declare(body, dir = mkdtempSync(join(tmpdir(), "anahid-declare-")), name = "project.json") {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ schema: "anahid.declaration/3", ...body }));
  return file;
}

/** A project whose Claude Code agent is owned by `owner`, bound to `path`. */
const project = (path, owner, extra = {}) => ({
  humans: owner ? { [owner]: { name: owner.toUpperCase(), role: "Lead" } } : {},
  agents: { cc: { owner: owner ?? null, parent: null } },
  sources: { hooks: { kind: "claude-code-hooks", agent: "cc", path } },
  ...extra,
});

test("the longest declared path answers, and a directory nobody declared is undeclared", () => {
  const dir = mkdtempSync(join(tmpdir(), "anahid-declare-"));
  declare(project("/work", "bob"), dir, "work.json");
  declare(project("/work/payments", "alice"), dir, "payments.json");
  const d = loadDeclarations([dir]);
  assert.deepEqual(answererFor(d, "claude-code", "/work/payments/api"), { declared: true, human: "alice" });
  assert.deepEqual(answererFor(d, "claude-code", "/work/web"), { declared: true, human: "bob" });
  assert.deepEqual(answererFor(d, "claude-code", "/work-other"), { declared: false, human: null },
                   "a shared prefix is not a parent directory");
  assert.deepEqual(answererFor(null, "claude-code", "/work"), { declared: false, human: null });
});

test("each engine answers through its own agent", () => {
  const d = loadDeclarations([declare({
    humans: { alice: {}, bob: {} },
    agents: { cc: { owner: "alice" }, cx: { owner: "bob" } },
    sources: { hooks: { kind: "claude-code-hooks", agent: "cc", path: "/work" },
               codex: { kind: "codex-hooks", agent: "cx", path: "/work" } },
  })]);
  assert.equal(answererFor(d, "claude-code", "/work/x").human, "alice");
  assert.equal(answererFor(d, "codex", "/work/x").human, "bob");
});

test("an agent answers through its parent, and a chain with no person is unaccountable", () => {
  const d = loadDeclarations([declare({
    humans: { alice: {} },
    agents: { lead: { owner: "alice" }, cc: { owner: null, parent: "lead" }, cx: { owner: null, parent: null } },
    sources: { hooks: { kind: "claude-code-hooks", agent: "cc", path: "/work" },
               codex: { kind: "codex-hooks", agent: "cx", path: "/work" } },
  })]);
  assert.deepEqual(answererFor(d, "claude-code", "/work"), { declared: true, human: "alice" });
  assert.deepEqual(answererFor(d, "codex", "/work"), { declared: true, human: null });
});

test("~ means the home directory", () => {
  const d = loadDeclarations([declare(project("~/code", "alice"))]);
  assert.equal(answererFor(d, "claude-code", join(homedir(), "code", "x")).human, "alice");
});

test("a product declaration loads as it is, and only name and role of a person are kept", () => {
  const d = loadDeclarations([declare(project("/work", "alice", {
    revision: 4, meta: { owner_note: "alice" },
    domains: { payment_data: { label: "Payment data", sens: "Critical" } },
    enforce: { enabled: false, blockDomains: [] },
    humans: { alice: { name: "Alice", role: "Lead", owns: ["payment_data"], webhook: "https://hooks.example/x", email: "a@example.com" } },
  }))]);
  assert.deepEqual({ ...d.humans.alice }, { name: "Alice", role: "Lead" });
});

test("an unusable declaration is refused with its reason", () => {
  const refused = (body, reason) => assert.throws(() => loadDeclarations([declare(body)]), reason);
  refused({ ...project("/w", "alice"), schema: "anahid.declaration/1" }, /schema must be "anahid.declaration\/3"/);
  refused({ ...project("/w", "alice"), agents: { cc: { owner: "constructor" } } }, /agent "cc" owner "constructor" is not a known human/);
  refused({ ...project("/w", "alice"), agents: { cc: { owner: null, parent: "ghost" } } }, /agent "cc" parent "ghost" is not a known agent/);
  refused({ ...project("/w", "alice"), sources: { hooks: { kind: "codex-hooks", agent: "ghost", path: "/w" } } },
          /source "hooks" names agent "ghost", which is not declared/);
  refused(project("code/w", "alice"), /source "hooks" path must be an absolute path or start with ~/);
  refused({ ...project("/w", "alice"), sources: {} }, /no claude-code-hooks or codex-hooks source has a "path"/);
  assert.throws(() => loadDeclarations(["/nonexistent.json"]), /not found/);
});

test("one person declared differently in two projects is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "anahid-declare-"));
  declare(project("/a", "alice"), dir, "a.json");
  declare({ ...project("/b", "alice"), humans: { alice: { name: "Someone else" } } }, dir, "b.json");
  assert.throws(() => loadDeclarations([dir]), /human "alice" is declared differently/);
});

test("the CLI reads the default declarations and counts acts per person", () => {
  const claude = mkdtempSync(join(tmpdir(), "anahid-cc-"));
  mkdirSync(join(claude, "projects", "-repo"), { recursive: true });
  const act = (id, cwd, i) => [
    { type: "assistant", sessionId: "s", cwd, timestamp: `2026-09-20T10:00:0${i}Z`,
      message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] } },
    { type: "user", sessionId: "s", timestamp: `2026-09-20T10:00:0${i}Z`,
      message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
  ];
  const recs = [...act("a", "/work/payments", 1), ...act("b", "/tmp/scratch", 2), ...act("c", "/work/kyc", 3)];
  writeFileSync(join(claude, "projects", "-repo", "s.jsonl"), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const home = mkdtempSync(join(tmpdir(), "anahid-home-"));
  const dir = join(home, "declarations");
  mkdirSync(dir, { recursive: true });
  declare(project("/work/payments", "alice"), dir, "payments.json");
  declare(project("/work/kyc", null), dir, "kyc.json");
  const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: mkdtempSync(join(tmpdir(), "x-")), ANAHID_HOME: home };
  const r = JSON.parse(execFileSync("node", [BIN, "--json"], { env, encoding: "utf8" })).reports[0];
  assert.equal(r.byHuman.alice.calls, 1);
  assert.equal(r.undeclared.calls, 1);
  assert.equal(r.unaccountable.calls, 1);
  const text = execFileSync("node", [BIN], { env, encoding: "utf8" });
  assert.match(text, /Who answers \(2 declarations\)\n  ALICE, Lead: 1 call, 0 refused\n  unaccountable \(declared, but no person answers\): 1 call, 0 refused\n  undeclared \(no declaration covers the directory\): 1 call, 0 refused/);
  const bad = spawnSync("node", [BIN, "--declaration", "/nonexistent.json"], { env, encoding: "utf8" });
  assert.equal(bad.status, 2);
});
