import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * Yield the lines of a JSONL file, split on "\n" only.
 *
 * node:readline also breaks on U+2028 and U+2029, which JSON allows raw inside
 * strings, so it cuts valid records in half.
 */
export async function* jsonlLines(file, { highWaterMark = 1 << 20 } = {}) {
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for await (const chunk of createReadStream(file, { highWaterMark })) {
    rest += decoder.write(chunk);
    let start = 0;
    let i;
    while ((i = rest.indexOf("\n", start)) !== -1) {
      yield rest.slice(start, i).replace(/\r$/, "");
      start = i + 1;
    }
    rest = rest.slice(start);
  }
  rest += decoder.end();
  if (rest) yield rest.replace(/\r$/, "");
}
