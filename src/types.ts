// Minerva wire protocol - the only contract between core and providers.
// Modeled on deepseek-dsh's neutral chunk vocabulary + OpenAI/OpenRouter SSE.

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  args: string; // raw JSON
}

export type ContentBlock = TextBlock | ToolCallBlock;

export interface Message {
  role: Role;
  content: ContentBlock[];
  toolCallId?: string; // set on role:"tool" messages
}

// Stream chunks: what an LLM adapter yields.
export type StreamChunk =
  | { kind: "text_delta"; text: string }
  | { kind: "block_start"; block: ContentBlock }
  | { kind: "finish"; stopReason: StopReason; usage?: Usage };

export type StopReason = "end_turn" | "tool_use" | "error" | "aborted";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateOptions {
  model: string;
  messages: Message[];
  system?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  tools?: unknown[]; // OpenAI-formatted function schemas
}

// The ONLY required method of an LLM adapter (dsh pattern).
export interface LlmAdapter {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
