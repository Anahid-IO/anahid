import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const cache = new Map();

/**
 * The main checkout of the git repository holding `dir`, shared by all its
 * worktrees. Null when the directory is gone or not in a repository.
 * Read from the .git folder or file on disk; git itself is never run.
 */
export function repoRoot(dir) {
  if (!dir) return null;
  if (!cache.has(dir)) cache.set(dir, lookup(dir));
  return cache.get(dir);
}

function lookup(dir) {
  if (!existsSync(dir)) return null;
  for (let d = realpathSync(dir); ; d = dirname(d)) {
    const dotGit = join(d, ".git");
    const kind = statKind(dotGit);
    if (kind === "dir") return d;
    if (kind === "file") return fromGitFile(d, dotGit);
    if (dirname(d) === d) return null;
  }
}

/** A worktree or submodule: .git is a file naming the git dir, whose commondir names the shared one. */
function fromGitFile(d, file) {
  const m = /^gitdir: (.+)$/m.exec(readFileSync(file, "utf8"));
  if (!m) return null;
  const gitDir = resolve(d, m[1].trim());
  const shared = join(gitDir, "commondir");
  const common = existsSync(shared) ? resolve(gitDir, readFileSync(shared, "utf8").trim()) : gitDir;
  if (!existsSync(common)) return null;
  const real = realpathSync(common);
  return basename(real) === ".git" ? dirname(real) : real;
}

function statKind(p) {
  try {
    const s = statSync(p);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : null;
  } catch {
    return null;
  }
}
