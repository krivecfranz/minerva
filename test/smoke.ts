// ponytail: one runnable end-to-end check, no framework.
import { runTurn } from "../src/core/agent.ts";
import { Session } from "../src/core/session.ts";
import webFetch from "../src/tools/webfetch.ts";
import type { LlmAdapter, StreamChunk } from "../src/types.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

// Scripted adapter: turn 1 asks for a tool call, turn 2 ends the loop.
const script: StreamChunk[][] = [
  [
    { kind: "text_delta", text: "Let me look that up." },
    {
      kind: "block_start",
      block: { type: "tool_call", id: "c1", name: "web_fetch", args: JSON.stringify({ url: "https://example.com" }) },
    },
    { kind: "finish", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 3 } },
  ],
  [
    { kind: "text_delta", text: "Example Domain is a placeholder website." },
    { kind: "finish", stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 } },
  ],
];
let call = 0;
const fakeAdapter: LlmAdapter = {
  async *stream() {
    yield* script[call++];
    if (call > script.length) throw new Error("adapter over-called");
  },
};

const session = await Session.create("/tmp/opencode/minerva-smoke");
const history = [];
let streamed = "";
let toolSeen = null;
let done = null;
for await (const ev of runTurn(fakeAdapter, session, history, "What is example.com?", [webFetch])) {
  if (ev.type === "text_delta") streamed += ev.text;
  else if (ev.type === "tool_start") toolSeen = ev.call.name;
  else done = ev;
}

assert(streamed.includes("Let me look"), "first model text streamed");
assert(toolSeen === "web_fetch", "tool call observed");
assert(done !== null && done.newMessages.length === 4, `turn_done carries user+assistant+tool+assistant (got ${done?.newMessages.length})`);
assert(done.newMessages.at(-1).content[0].text.includes("placeholder"), "final answer uses tool result");
assert(done.usage.outputTokens === 2, "usage from last finish chunk");

const replayed = await Session.open("/tmp/opencode/minerva-smoke", session.id);
const msgs = await replayed.messages();
assert(msgs.length === 4, `transcript replay has all 4 messages (got ${msgs.length})`);
const toolMsg = msgs.find((m) => m.role === "tool");
assert(Boolean(toolMsg), "tool result persisted");
assert(toolMsg.toolCallId === "c1", "tool message carries toolCallId for wire mapping");

console.log("\nSMOKE OK");
