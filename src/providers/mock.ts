import type { LlmAdapter, StreamChunk } from "../types.ts";

// Keyless provider for smoke tests / offline dev.
export class MockAdapter implements LlmAdapter {
  private reply: string;
  constructor(reply = "Hello! I am Minerva (mock).") {
    this.reply = reply;
  }
  async *stream(options): AsyncIterable<StreamChunk> {
    const last = options.messages.at(-1);
    const text =
      last?.role === "user"
        ? `${this.reply} You said: ${last.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join(" ")}`
        : this.reply;
    for (const word of text.split(/(\s+)/)) {
      if (options.signal?.aborted) {
        yield { kind: "finish", stopReason: "aborted" };
        return;
      }
      yield { kind: "text_delta", text: word };
    }
    yield {
      kind: "finish",
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}
