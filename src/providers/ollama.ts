import type { ContentBlock, GenerateOptions, LlmAdapter, Message, StopReason, StreamChunk, ToolCallBlock, Usage } from "../types";

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

// ponytail: ollama streams NDJSON, not SSE - one JSON object per line
interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface OllamaMessage {
  role?: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaStreamLine {
  message?: OllamaMessage;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function textOf(message: Message): string {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function toolCallsOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === "tool_call");
}

// ponytail: ollama wants tool_name (not id) on tool results - recover it from the preceding assistant tool_calls
function toolNameById(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>();
  let last: ToolCallBlock[] = [];
  for (const message of messages) {
    const calls = toolCallsOf(message);
    if (message.role === "assistant" && calls.length > 0) last = calls;
    if (message.role === "tool" && message.toolCallId !== undefined) {
      names.set(message.toolCallId, last.find((tc) => tc.id === message.toolCallId)?.name ?? "");
    }
  }
  return names;
}

function safeParse(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function messageToOllama(message: Message, names: Map<string, string>): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      content: textOf(message),
      tool_name: names.get(message.toolCallId ?? "") ?? "",
    };
  }
  const out: Record<string, unknown> = { role: message.role, content: textOf(message) };
  const calls = toolCallsOf(message);
  if (calls.length > 0) {
    // ponytail: ollama expects arguments as an OBJECT, not a JSON string
    out.tool_calls = calls.map((tc) => ({ function: { name: tc.name, arguments: safeParse(tc.args) } }));
  }
  return out;
}

export class OllamaAdapter implements LlmAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  }

  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const names = toolNameById(options.messages);
    const messages = options.messages.map((message) => messageToOllama(message, names));
    if (options.system !== undefined) {
      messages.unshift({ role: "system", content: options.system });
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
    };
    if (options.tools?.length) {
      body.tools = options.tools;
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      });
    } catch (err) {
      if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        yield { kind: "finish", stopReason: "aborted" };
        return;
      }
      // ponytail: ECONNREFUSED means the daemon is down - say so instead of raw errno noise
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "ECONNREFUSED") {
        throw new Error(`Ollama not reachable at ${this.baseUrl} - is it running?`);
      }
      throw err;
    }

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`Ollama request failed with status ${response.status}: ${text.slice(0, 500)}`);
    }

    // ponytail: tool_calls arrive whole per line - buffer them, flush as blocks after the stream ends
    const pending: PendingToolCall[] = [];
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stopReason: StopReason | null = null;
    let usage: Usage | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length === 0) continue;

          let parsed: OllamaStreamLine;
          try {
            parsed = JSON.parse(line) as OllamaStreamLine;
          } catch {
            continue;
          }

          if (parsed.message?.content) {
            yield { kind: "text_delta", text: parsed.message.content };
          }

          if (parsed.message?.tool_calls) {
            for (const tc of parsed.message.tool_calls) {
              // ponytail: arguments are already an object here - stringify once for our wire format
              pending.push({
                id: `call_${pending.length}`,
                name: tc.function?.name ?? "",
                args: JSON.stringify(tc.function?.arguments ?? {}),
              });
            }
          }

          if (parsed.done) {
            stopReason = pending.length > 0 ? "tool_use" : "end_turn";
            usage = { inputTokens: parsed.prompt_eval_count ?? 0, outputTokens: parsed.eval_count ?? 0 };
          }
        }
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
        // no tool flush on abort - aborted calls must never execute downstream
        yield { kind: "finish", stopReason: "aborted" };
        return;
      }
      throw err;
    }

    for (const p of pending) {
      yield { kind: "block_start", block: { type: "tool_call", id: p.id, name: p.name, args: p.args } };
    }

    yield {
      kind: "finish",
      stopReason: stopReason ?? (pending.length > 0 ? "tool_use" : "end_turn"),
      ...(usage ? { usage } : {}),
    };
  }
}
