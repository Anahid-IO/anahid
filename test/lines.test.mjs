import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jsonlLines } from "../src/lines.mjs";

const dir = mkdtempSync(join(tmpdir(), "anahid-lines-"));

async function collect(content, opts) {
  const p = join(dir, `f${Math.random()}.jsonl`);
  writeFileSync(p, content);
  const out = [];
  for await (const l of jsonlLines(p, opts)) out.push(l);
  return out;
}

test("U+2028 and U+2029 inside a JSON string do not split the record", async () => {
  const rec = JSON.stringify({ text: "a b c" }).replace(/\\u2028/g, " ").replace(/\\u2029/g, " ");
  const lines = await collect(`${rec}\n{"x":1}\n`);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).text, "a b c");
});

test("CRLF endings and a missing final newline", async () => {
  assert.deepEqual(await collect('{"a":1}\r\n{"b":2}'), ['{"a":1}', '{"b":2}']);
});

test("a multibyte character split across chunks survives", async () => {
  const rec = JSON.stringify({ t: "ü".repeat(10) + "€" });
  const lines = await collect(`${rec}\n`, { highWaterMark: 3 });
  assert.equal(JSON.parse(lines[0]).t, "ü".repeat(10) + "€");
});
