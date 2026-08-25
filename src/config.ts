// ponytail: flat config, env-first. Move to YAML layering when it hurts.
export const model = process.env.MINERVA_MODEL ?? "anthropic/claude-sonnet-4.5";
export const maxTokens = Number(process.env.MINERVA_MAX_TOKENS ?? 1200);
