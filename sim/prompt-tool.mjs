#!/usr/bin/env node
// A minimal MCP server whose one tool answers Claude Code's permission prompts
// (--permission-prompt-tool). It answers SIM_BEHAVIOR ("deny" or "allow") to
// every prompt, so a simulation can see how a program's answer is recorded.
import { createInterface } from "node:readline";

const behavior = process.env.SIM_BEHAVIOR || "deny";
const message = process.env.SIM_MESSAGE || "The sim prompt tool refuses every request.";

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
                    serverInfo: { name: "sim-prompt", version: "0.1.0" } });
  } else if (msg.method === "tools/list") {
    reply(msg.id, { tools: [{ name: "decide", description: "Answers permission prompts.",
                              inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } } } }] });
  } else if (msg.method === "tools/call") {
    const answer = behavior === "allow"
      ? { behavior: "allow", updatedInput: msg.params?.arguments?.input ?? {} }
      : { behavior: "deny", message };
    reply(msg.id, { content: [{ type: "text", text: JSON.stringify(answer) }] });
  } else if (msg.id !== undefined) {
    reply(msg.id, {});
  }
});
