import { readFileSync } from "node:fs";

export const LAYERS = ["person", "unanswered", "rule", "hook", "classifier", "program", "sandbox", "builtin", "interrupted", "unknown"];

/** Load a signature table and compile its patterns once. */
export function loadSignatures(url) {
  const table = JSON.parse(readFileSync(url, "utf8"));
  return {
    ...table,
    signatures: table.signatures.map((s) => ({ ...s, re: new RegExp(s.pattern, "s") })),
  };
}

/**
 * Place one refused tool result in a layer.
 *
 * Returns null when the result is not a refusal: an error with no denial label
 * and no matching signature is a plain tool failure. `table.vendorLabels` maps
 * each vendor label to the layer it claims, and a signature's `claims` names the
 * layer its own wording blames, so a wrong claim is reported either way.
 */
export function classify({ text, denialKind, sidechain = false }, table) {
  const body = stripErrorPrefix(text);
  for (const sig of table.signatures) {
    if (sig.denialKind && sig.denialKind !== denialKind) continue;
    if (sig.sidechain && !sidechain) continue;
    const m = sig.re.exec(body);
    if (!m) continue;
    return refusal(sig.layer, sig, denialKind, table.vendorLabels, m.groups);
  }
  if (denialKind) return refusal("unknown", null, denialKind, table.vendorLabels);
  return null;
}

function refusal(layer, sig, denialKind, vendorLabels = {}, groups = {}) {
  const claimed = (Object.hasOwn(vendorLabels, denialKind ?? "") ? vendorLabels[denialKind] : null) ?? sig?.claims ?? null;
  return {
    layer,
    asker: sig?.asker ?? null,
    signature: sig?.id ?? null,
    detail: groups?.reason ?? groups?.hook ?? null,
    vendorLabel: denialKind ?? null,
    inferred: Boolean(sig?.inferred),
    mislabelled: claimed !== null && claimed !== layer,
  };
}

function stripErrorPrefix(text) {
  return String(text ?? "").replace(/^Error: /, "").trimStart();
}
