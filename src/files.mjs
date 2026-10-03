import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Every .jsonl under `root`, sorted. Symlinks are not followed. */
export function findJsonl(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}
