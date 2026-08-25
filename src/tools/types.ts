export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  signal?: AbortSignal;
}

// Fail-closed by construction: execute is required, everything risky is opt-in later.
export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool(def: ToolDef): ToolDef {
  return def;
}

export function toolToOpenAiSchema(tool: ToolDef): unknown {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}
