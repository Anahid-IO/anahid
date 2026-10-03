/** A number as the report prints it: 12,345. */
export const n = (x) => x.toLocaleString("en-US");

/** "1 tool call", "2 tool calls". */
export function count(x, one, many = `${one}s`) {
  return `${n(x)} ${x === 1 ? one : many}`;
}

/** The verb form that agrees with a count: agree(1, "has", "have") is "has". */
export const agree = (x, one, many) => (x === 1 ? one : many);
