import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classify, loadSignatures } from "../src/classify.mjs";

const spec = (path) => new URL(`../spec/${path}`, import.meta.url);
const table = loadSignatures(spec("signatures/claude-code.json"));

for (const agent of ["claude-code", "codex"]) {
  const t = loadSignatures(spec(`signatures/${agent}.json`));
  const vectors = readFileSync(spec(`vectors/${agent}.jsonl`), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));

  for (const v of vectors) {
    test(`${agent} ${v.layer ?? "not a refusal"}: ${v.text.slice(0, 60)}`, () => {
      const got = classify({ text: v.text, denialKind: v.denialKind ?? undefined, sidechain: v.sidechain }, t);
      if (v.layer === null) return assert.equal(got, null);
      assert.equal(got.layer, v.layer);
      assert.equal(got.signature, v.signature);
      assert.equal(got.mislabelled, v.mislabelled);
      if (v.detail) assert.equal(got.detail, v.detail);
    });
  }

  test(`${agent}: every signature is exercised by a vector`, () => {
    const used = new Set(vectors.map((v) => v.signature).filter(Boolean));
    const missing = t.signatures.map((s) => s.id).filter((id) => !used.has(id));
    assert.deepEqual(missing, []);
  });
}

test("a tool-wide denial outside a subagent is still a rule", () => {
  const got = classify({ text: "Permission to use Bash has been denied.", denialKind: "permission-rule" }, table);
  assert.equal(got.signature, "cc.rule");
});

test("a leading 'Error: ' is ignored", () => {
  const got = classify({ text: "Error: This command requires approval", denialKind: "user-rejected" }, table);
  assert.equal(got.signature, "cc.ask-command");
});

test("a denial label named like an Object.prototype member claims no layer", () => {
  const f = classify({ text: "some text nobody matches", denialKind: "constructor" }, table);
  assert.equal(f.layer, "unknown");
  assert.equal(f.mislabelled, false);
});
