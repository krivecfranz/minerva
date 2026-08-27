import type { GenerateOptions, LlmAdapter, Message, ToolCallBlock } from "../types.ts";
import type { Session } from "./session.ts";
import type { ToolDef } from "../tools/types.ts";
import { toolToOpenAiSchema } from "../tools/types.ts";
import { executeToolCall } from "./subagents.ts";
import { model, maxTokens } from "../config.ts";

export type LoopEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; call: ToolCallBlock }
  | {
      type: "turn_done";
      newMessages: Message[];
      usage?: { inputTokens: number; outputTokens: number };
    };

export function tutorSystem(extra?: string): string {
  return [
    `You are Minerva, a personal tutor. Core rules:
- Maximize struggle in the material, minimize struggle in logistics.
- One reasoning step per turn, and you MUST end every single reply with exactly ONE question to the learner - never a statement, never zero questions.
- Prefer asking over telling (Socratic). Never hand over a full solution while a guided path exists.
- When the learner states something wrong or overconfident: address the specific misconception directly (say what is wrong and why), then guide back on track.
- Mark unverified claims as [unsicher]. Cite vault notes or sources when available.`,
    extra,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ponytail: fixed cap instead of budget ladder - add compaction when sessions get long.
const MAX_STEPS = 16;

// Agentic loop: model -> tool calls -> results -> repeat until end_turn.
export async function* runTurn(
  adapter: LlmAdapter,
  session: Session,
  history: Message[],
  input: string,
  tools: ToolDef[],
  opts?: { system?: string; signal?: AbortSignal; model?: string },
): AsyncGenerator<LoopEvent> {
  const userMsg: Message = { role: "user", content: [{ type: "text", text: input }] };
  await session.append("message", userMsg);

  const messages = [...history, userMsg];
  const schemas = tools.map(toolToOpenAiSchema);
  let lastUsage;

  for (let step = 0; step < MAX_STEPS; step++) {
    const genOpts: GenerateOptions = {
      model: opts?.model ?? model,
      messages,
      maxTokens,
      system: opts?.system ?? tutorSystem(),
      signal: opts?.signal,
      ...(schemas.length ? { tools: schemas } : {}),
    };

    let text = "";
    const calls: ToolCallBlock[] = [];
    let aborted = false;
    for await (const chunk of adapter.stream(genOpts)) {
      if (chunk.kind === "text_delta") {
        text += chunk.text;
        yield { type: "text_delta", text: chunk.text };
      } else if (chunk.kind === "block_start" && chunk.block.type === "tool_call") {
        calls.push(chunk.block);
        yield { type: "tool_start", call: chunk.block };
      } else if (chunk.kind === "finish") {
        if (chunk.stopReason === "aborted") aborted = true;
        lastUsage = chunk.usage ?? lastUsage; // a later finish frame without usage must not erase it
      }
    }

    const assistantMsg: Message = {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((c) => ({ type: "tool_call" as const, ...c })),
      ],
    };
    await session.append("message", assistantMsg);
    messages.push(assistantMsg);

    // an aborted turn must never execute tools
    if (!calls.length || aborted) break;

    for (const call of calls) {
      const resultMsg = await executeToolCall(tools, call, opts?.signal);
      await session.append("message", resultMsg);
      messages.push(resultMsg);
    }
  }

  yield { type: "turn_done", newMessages: messages.slice(history.length), usage: lastUsage };
}
