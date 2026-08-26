import type { ContentBlock, GenerateOptions, LlmAdapter, Message, StopReason, StreamChunk, ToolCallBlock, Usage } from "../types";

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

interface OpenAiToolCallDelta {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiDelta {
  content?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: OpenAiDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
}

function messageToOpenAi(message: Message): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(""),
    };
  }
  const toolCalls = message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
  const out: Record<string, unknown> = {
    role: message.role,
    content: text,
  };
  if (toolCalls.length > 0) {
    out.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args },
    }));
  }
  return out;
}

// ponytail: also serves LM Studio and any other OpenAI-compatible /chat/completions server - same wire format, no key needed.
export class OpenRouterAdapter implements LlmAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;

  constructor(baseUrl = "https://openrouter.ai/api/v1", apiKey?: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey ?? process.env.OPENROUTER_API_KEY;
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const apiKey = this.apiKey;
    if (!apiKey && this.baseUrl.includes("openrouter.ai")) {
      throw new Error("OpenRouter API key missing: pass it to the constructor or set OPENROUTER_API_KEY");
    }

    const messages = options.messages.map(messageToOpenAi);
    if (options.system !== undefined) {
      messages.unshift({ role: "system", content: options.system });
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
    };
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }
    if (options.tools?.length) {
      body.tools = options.tools;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        yield { kind: "finish", stopReason: "aborted" };
        return;
      }
      throw err;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenRouter request failed with status ${response.status}: ${text.slice(0, 500)}`);
    }

    const completedToolCalls: PendingToolCall[] = [];
    const openById = new Map<number | undefined, PendingToolCall>();
    const bufferByIndex = new Map<number | undefined, string>();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";
    let stopReason: StopReason | null = null;
    let usage: Usage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = sseBuffer.indexOf("\n")) !== -1) {
          const line = sseBuffer.slice(0, newlineIndex).replace(/\r$/, "");
          sseBuffer = sseBuffer.slice(newlineIndex + 1);

          if (line.startsWith(":") || line.length === 0) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;

          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(data) as OpenAiChunk;
          } catch {
            continue;
          }

          if (chunk.usage) {
            // usage-only final frames carry empty choices - handle before the guard
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta?.content) {
            yield { kind: "text_delta", text: delta.content };
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let pending = openById.get(idx);
              if (!pending) {
                pending = { id: tc.id ?? "", name: "", args: "" };
                openById.set(idx, pending);
              }
              if (tc.id) pending.id = tc.id;
              // ponytail: accumulate streamed name/args fragments instead of emitting partial blocks
              if (tc.function?.name) pending.name += tc.function.name;
              if (tc.function?.arguments) bufferByIndex.set(idx, (bufferByIndex.get(idx) ?? "") + tc.function.arguments);
            }
          }

          if (choice.finish_reason != null) {
            stopReason = mapFinishReason(choice.finish_reason);
          }
        }
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        for (const block of flushToolCalls(openById, bufferByIndex)) {
          yield { kind: "block_start", block };
        }
        yield { kind: "finish", stopReason: "aborted" };
        return;
      }
      throw err;
    }

    for (const block of flushToolCalls(openById, bufferByIndex)) {
      yield { kind: "block_start", block };
    }

    if (stopReason === null) {
      stopReason = openById.size > 0 ? "tool_use" : "end_turn";
    }
    yield { kind: "finish", stopReason, ...(usage ? { usage } : {}) };
  }
}

function flushToolCalls(
  openById: Map<number | undefined, PendingToolCall>,
  bufferByIndex: Map<number | undefined, string>,
): ToolCallBlock[] {
  const blocks: ToolCallBlock[] = [];
  for (const [idx, pending] of openById) {
    blocks.push({ type: "tool_call", id: pending.id, name: pending.name, args: bufferByIndex.get(idx) ?? "" });
  }
  return blocks;
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}
