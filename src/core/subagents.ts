import { readdir, readFile } from "node:fs/promises";
import type { LlmAdapter, Message, ToolCallBlock, Usage } from "../types.ts";
import type { ToolDef } from "../tools/types.ts";
import { toolToOpenAiSchema } from "../tools/types.ts";
import { model as defaultModel, maxTokens as defaultMaxTokens } from "../config.ts";

// ponytail: ephemeral workers - no session, no persistence, fresh context each run.
export interface SubAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: ToolDef[];
  model?: string;
}

const MAX_STEPS = 8;
const SUBAGENT_SUFFIX =
  "\n\nYou are running as an isolated subagent. Work autonomously. Your final text response IS the deliverable - make it self-contained.";

// ponytail: shared executor so agent.ts can reuse it later; errors become tool results, not crashes.
export async function executeToolCall(
  tools: ToolDef[],
  call: ToolCallBlock,
  signal?: AbortSignal,
): Promise<Message> {
  const tool = tools.find((t) => t.name === call.name);
  let content: string;
  if (!tool) {
    content = `Error: unknown tool "${call.name}"`;
  } else {
    try {
      const args = JSON.parse(call.args || "{}");
      const res = await tool.execute(args, { signal });
      content = res.content;
    } catch (err) {
      content = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    role: "tool",
    toolCallId: call.id,
    content: [{ type: "text", text: content }],
  };
}

export async function runSubAgent(
  adapter: LlmAdapter,
  agent: SubAgent,
  task: string,
  opts?: { signal?: AbortSignal },
): Promise<{ result: string; usage?: Usage }> {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: task }] }];
  const schemas = agent.tools.map(toolToOpenAiSchema);
  let result = "";
  let usage: Usage | undefined;

  for (let step = 0; step < MAX_STEPS; step++) {
    let text = "";
    const calls: ToolCallBlock[] = [];
    for await (const chunk of adapter.stream({
      model: agent.model ?? defaultModel,
      maxTokens: defaultMaxTokens,
      messages,
      system: agent.systemPrompt + SUBAGENT_SUFFIX,
      signal: opts?.signal,
      ...(schemas.length ? { tools: schemas } : {}),
    })) {
      if (chunk.kind === "text_delta") text += chunk.text;
      else if (chunk.kind === "block_start" && chunk.block.type === "tool_call") calls.push(chunk.block);
      else if (chunk.kind === "finish") usage = chunk.usage ?? usage;
    }

    result += (result && text ? "\n\n" : "") + text;
    messages.push({
      role: "assistant",
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...calls.map((c) => ({ type: "tool_call" as const, ...c })),
      ],
    });

    if (!calls.length) break;
    for (const call of calls) messages.push(await executeToolCall(agent.tools, call, opts?.signal));
  }

  return { result, usage };
}

// ponytail: hand-rolled frontmatter parse - YAML subset only, swap when it hurts.
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

export async function loadAgents(dir: string, allTools: ToolDef[]): Promise<SubAgent[]> {
  // ponytail: missing dir is not fatal - running from another cwd should not crash the CLI
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
  const agents: SubAgent[] = [];
  for (const file of files) {
    const raw = await readFile(`${dir}/${file}`, "utf8");
    const { meta, body } = parseFrontmatter(raw);
    if (!meta.name) continue;
    agents.push({
      name: meta.name,
      description: meta.description ?? "",
      systemPrompt: body.trim(),
      tools: (meta.tools ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((name) => allTools.find((t) => t.name === name))
        .filter((t): t is ToolDef => Boolean(t)),
      ...(meta.model ? { model: meta.model } : {}),
    });
  }
  return agents;
}
