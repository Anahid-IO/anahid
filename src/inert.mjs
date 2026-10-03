// Control characters except newline, C1 controls, bidi overrides and line separators.
const RANGES = [[0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200e, 0x200f],
                [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const escape = (code) => "\\u" + code.toString(16).padStart(4, "0");
const UNSAFE = new RegExp(`[${RANGES.map(([a, b]) => `${escape(a)}-${escape(b)}`).join("")}]`, "g");

/**
 * Text safe to print: every character a terminal would act on is written as a \uXXXX escape.
 * The escape is also valid inside a JSON string, so JSON output stays parseable.
 */
export function inert(text) {
  return text.replace(UNSAFE, (c) => escape(c.charCodeAt(0)));
}
