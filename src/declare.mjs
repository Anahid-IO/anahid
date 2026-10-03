import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const SCHEMA = "anahid.declaration/3";

/** The source kind whose `agent` acts for each engine this tool reads. */
const KIND_OF = { "claude-code": "claude-code-hooks", codex: "codex-hooks" };
const AGENT_KINDS = Object.values(KIND_OF);
const isObj = (o) => !!o && typeof o === "object" && !Array.isArray(o);

/** Where declarations are read from when none is named: $ANAHID_HOME/declarations. Never created. */
export function defaultDeclarationsDir(env = process.env) {
  return join(env.ANAHID_HOME || join(homedir(), ".anahid"), "declarations");
}

/**
 * Load declarations from files and directories (every *.json in a directory).
 * Each file is an `anahid.declaration/3` for one project, the same file the Anahid product reads.
 * Only `humans`, `agents` and the hooks `sources` are used; everything else is left as it is.
 * Throws with a plain message naming the file when one is unusable.
 */
export function loadDeclarations(paths) {
  const files = paths.flatMap((p) => {
    if (!existsSync(p)) throw new Error(`declaration ${p}: not found`);
    return statSync(p).isDirectory()
      ? readdirSync(p).filter((f) => f.endsWith(".json")).sort().map((f) => join(p, f))
      : [p];
  });
  const humans = Object.create(null);
  const bindings = [];
  for (const file of files) {
    const d = parse(file);
    for (const [key, h] of Object.entries(d.humans)) {
      const person = { name: h.name ?? null, role: h.role ?? null };
      if (Object.hasOwn(humans, key) && JSON.stringify(humans[key]) !== JSON.stringify(person)) {
        throw new Error(`declaration ${file}: human "${key}" is declared differently in another declaration`);
      }
      humans[key] = person;
    }
    const bound = Object.values(d.sources).filter((s) => AGENT_KINDS.includes(s.kind) && s.path != null);
    if (!bound.length) throw new Error(`declaration ${file}: no claude-code-hooks or codex-hooks source has a "path"`);
    for (const s of bound) {
      bindings.push({ kind: s.kind, paths: forms(s.path), human: answerableHuman(s.agent, d) });
    }
  }
  return { sources: files, humans, bindings };
}

/**
 * Who answers for an act of `engine` in `project`: the declaration whose source path is the
 * longest prefix of it. `declared` is false when no declaration covers the directory;
 * `human` is null when one does but its agent's chain reaches no person.
 */
export function answererFor(declarations, engine, project) {
  if (!declarations || !project) return { declared: false, human: null };
  let best = null;
  for (const b of declarations.bindings) {
    if (b.kind !== KIND_OF[engine]) continue;
    for (const path of b.paths) {
      if ((project === path || project.startsWith(path + "/")) && (!best || path.length > best.length)) {
        best = { length: path.length, human: b.human };
      }
    }
  }
  return best ? { declared: true, human: best.human } : { declared: false, human: null };
}

function parse(file) {
  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`declaration ${file}: not valid JSON`);
  }
  const fail = (why) => new Error(`declaration ${file}: ${why}`);
  if (!isObj(d) || d.schema !== SCHEMA) throw fail(`schema must be "${SCHEMA}"`);
  for (const k of ["humans", "agents", "sources"]) {
    if (d[k] != null && !isObj(d[k])) throw fail(`"${k}" must be an object`);
    d[k] ??= {};
    for (const [key, v] of Object.entries(d[k])) if (!isObj(v)) throw fail(`${k} "${key}" must be an object`);
  }
  for (const [k, a] of Object.entries(d.agents)) {
    if (a.owner != null && !Object.hasOwn(d.humans, a.owner)) throw fail(`agent "${k}" owner "${a.owner}" is not a known human`);
    if (a.parent != null && !Object.hasOwn(d.agents, a.parent)) throw fail(`agent "${k}" parent "${a.parent}" is not a known agent`);
  }
  for (const [k, s] of Object.entries(d.sources)) {
    if (!AGENT_KINDS.includes(s.kind)) continue;
    if (!Object.hasOwn(d.agents, s.agent)) throw fail(`source "${k}" names agent "${s.agent}", which is not declared`);
    if (s.path != null && (typeof s.path !== "string" || !/^(\/|~(\/|$))/.test(s.path))) {
      throw fail(`source "${k}" path must be an absolute path or start with ~`);
    }
  }
  return d;
}

/** The person an agent answers to: its owner, else its parent's, as the Anahid engine walks it. */
function answerableHuman(agentKey, { agents }) {
  const seen = new Set();
  for (let k = agentKey; k != null && !seen.has(k) && Object.hasOwn(agents, k); k = agents[k].parent) {
    seen.add(k);
    if (agents[k].owner != null) return agents[k].owner;
  }
  return null;
}

/** A declared path as written and, when it exists, as the system resolves it (/var and /private/var on macOS). */
function forms(path) {
  const abs = resolve(path.replace(/^~(?=$|\/)/, homedir())).replace(/\/+$/, "");
  const out = new Set([abs]);
  if (existsSync(abs)) out.add(realpathSync(abs));
  return [...out];
}
