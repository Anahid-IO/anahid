#!/usr/bin/env node
import { parseArgs } from "node:util";
import { LAYERS } from "../src/classify.mjs";
import { inert } from "../src/inert.mjs";
import { renderAll, tildePaths } from "../src/report.mjs";
import { AGENTS, agentOf, scan } from "../src/scan.mjs";
import { defaultDeclarationsDir, loadDeclarations } from "../src/declare.mjs";
import { parseSince } from "../src/since.mjs";
import { existsSync, readFileSync } from "node:fs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version;

const USAGE = `Usage: anahid [refusals] [transcript.jsonl ...] [options]

Reads Claude Code and Codex transcripts already on this machine and reports
which layer refused each tool call, and what the record cannot see. Nothing is
installed, sent or written.

Options
  --engine <name>     claude-code, codex or all (default all that have transcripts)
  --since <date|Nd>   only calls on or after a date (2026-09-01) or N days ago (7d)
  --examples <n>      examples per layer, with file:line (default 0). They quote
                      commands, so check them for secrets before sharing
  --declaration <p>   an anahid.declaration/3 file, or a directory of them; may repeat
                      (default ~/.anahid/declarations if present)
  --json              machine-readable output (schema anahid.refusals/1)
  --fail-on <layers>  exit 1 if any call was refused by one of these layers,
                      comma-separated (unanswered,classifier), or if nothing was scanned
  -h, --help          this text
  --version           the version

CLAUDE_CONFIG_DIR, CODEX_HOME and ANAHID_HOME are honoured.

Exit codes: 0 report printed, 1 a --fail-on layer refused or nothing was scanned,
2 bad arguments or declaration, 3 the scan failed.
`;

const OPTIONS = {
  engine: { type: "string", default: "all" },
  since: { type: "string" },
  declaration: { type: "string", multiple: true },
  examples: { type: "string", default: "0" },
  json: { type: "boolean", default: false },
  "fail-on": { type: "string" },
  help: { type: "boolean", short: "h", default: false },
  version: { type: "boolean", default: false },
};

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    return write(`${e.message.split(". ")[0]}\n\n${USAGE}`, 2, true);
  }
  const { values, positionals } = parsed;
  if (values.help) return write(USAGE, 0);
  if (values.version) return write(`${VERSION}\n`, 0);
  const [cmd, ...rest] = positionals;
  const files = cmd === "refusals" ? rest : positionals;
  if (cmd && cmd !== "refusals" && !cmd.endsWith(".jsonl")) return write(`unknown command '${cmd}'\n\n${USAGE}`, 2, true);

  const missing = files.find((f) => !existsSync(f));
  if (missing) return write(`${missing}: no such file\n`, 2, true);

  const examples = Number(values.examples);
  if (!Number.isInteger(examples) || examples < 0) return write("--examples takes a whole number\n", 2, true);
  const since = values.since ? parseSince(values.since) : null;
  if (values.since && !since) return write(`--since: cannot read '${values.since}'\n`, 2, true);
  const failOn = values["fail-on"]?.split(",").map((l) => l.trim()).filter(Boolean) ?? [];
  const badLayer = failOn.find((l) => !LAYERS.includes(l));
  if (badLayer) return write(`--fail-on: unknown layer '${badLayer}'. Layers: ${LAYERS.join(", ")}\n`, 2, true);
  if (values["fail-on"] !== undefined && !failOn.length) return write("--fail-on takes one or more layers\n", 2, true);
  if (values.engine !== "all" && !AGENTS[values.engine]) return write(`--engine: unknown engine '${values.engine}'\n`, 2, true);

  const declared = values.declaration ?? (existsSync(defaultDeclarationsDir()) ? [defaultDeclarationsDir()] : null);
  let declaration = null;
  if (declared) {
    try {
      declaration = loadDeclarations(declared);
    } catch (e) {
      return write(`${e.message}\n`, 2, true);
    }
  }
  const planned = plan(values.engine, files);
  if (!planned.length) return write(`no transcript given belongs to --engine ${values.engine}\n`, 2, true);
  const reports = [];
  for (const [agent, list] of planned) {
    reports.push(await scan({ agent, files: list, since, examples, declaration }));
  }
  const out = values.json
    ? JSON.stringify(tildePaths({ schema: "anahid.refusals/1", generator: { name: "anahid", version: VERSION },
                                  generatedAt: new Date().toISOString(), arguments: argv, reports }), null, 2) + "\n"
    : renderAll(reports, { examples: examples > 0 });
  write(out, 0);
  if (!files.length && reports.every((r) => !r.files)) {
    const looked = (values.engine === "all" ? Object.keys(AGENTS) : [values.engine]).map((a) => tildePaths(AGENTS[a].home(process.env)));
    write(`No transcripts found under ${looked.join(" or ")}.\n`, 0, true);
  }
  return failOn.length ? failed(reports, failOn) : 0;
}

/** 1 when a --fail-on layer refused a call, or when nothing was scanned; the reason goes to stderr. */
function failed(reports, failOn) {
  if (!reports.some((r) => r.calls)) return write("--fail-on: no tool calls were scanned\n", 1, true);
  const hits = failOn.map((l) => [l, reports.reduce((s, r) => s + r.byLayer[l], 0)]).filter(([, c]) => c);
  return hits.length ? write(`--fail-on: ${hits.map(([l, c]) => `${c} ${l}`).join(", ")}\n`, 1, true) : 0;
}

/** Which engines to scan, and with which files. Named files pick their own engine. */
function plan(engine, files) {
  const wanted = engine === "all" ? Object.keys(AGENTS) : [engine];
  if (files.length) {
    return wanted.map((a) => [a, files.filter((f) => agentOf(f) === a)]).filter(([, l]) => l.length);
  }
  const found = wanted.map((a) => [a, AGENTS[a].find(AGENTS[a].home(process.env))]).filter(([, l]) => l.length);
  return found.length ? found : [[wanted[0], []]];
}

function write(text, code, err = false) {
  (err ? process.stderr : process.stdout).write(inert(text));
  return code;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (e) => { process.stderr.write(inert(`anahid: ${e.message}\n`)); process.exitCode = 3; },
);
