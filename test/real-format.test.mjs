import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSignatures } from "../src/classify.mjs";
import { AGENTS, scan } from "../src/scan.mjs";

// Real records with every command, path and message scrubbed to a placeholder.
// They pin the field names and nesting the readers depend on.
const fixture = (name) => new URL(`fixtures/real/${name}`, import.meta.url).pathname;

test("real Claude Code records: one refusal per signature, one hook timeout", async () => {
  const r = await scan({ agent: "claude-code", files: [fixture("claude-code.jsonl")], home: "/nonexistent" });
  const table = loadSignatures(AGENTS["claude-code"].table);
  assert.deepEqual(Object.keys(r.bySignature).sort(), table.signatures.map((s) => s.id).sort());
  assert.ok(Object.values(r.bySignature).every((n) => n === 1));
  assert.equal(r.hookTimeoutsRanUnchecked, 1);
  assert.equal(r.byLayer.person, 1);
  assert.equal(r.mislabelled, 13);
});

test("real Codex records: declined item, text-only refusals and reviewer verdicts", async () => {
  const r = await scan({ agent: "codex", files: [fixture("rollout-main.jsonl"), fixture("rollout-reviewer.jsonl")], home: "/nonexistent" });
  assert.equal(r.calls, 6);
  assert.equal(r.failed, 1);
  assert.equal(r.refused, 3);
  assert.deepEqual(r.bySignature, { "cx.reviewer-timeout": 2, "cx.reviewer-denied": 1 });
  assert.deepEqual([r.reviews.requests, r.reviews.allow, r.reviews.deny, r.reviews.noVerdict], [3, 1, 1, 1]);
  assert.deepEqual(r.versions, ["0.149.0"]);
});
