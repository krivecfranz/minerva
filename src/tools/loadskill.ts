import { defineTool } from "./types.ts";
import { loadSkillBody, type Skill } from "../core/skills.ts";

// ponytail: the system prompt has always promised this tool. It just never existed.
export function loadSkillTool(skills: Skill[]) {
  const names = skills.map((s) => s.name).join(", ");
  return defineTool({
    name: "load_skill",
    description: `Load the full protocol of a teaching skill by name, then follow it. Available: ${names}`,
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: `One of: ${names}` } },
      required: ["name"],
    },
    async execute(args) {
      const name = String(args.name ?? "").trim();
      const skill = skills.find((s) => s.name === name);
      if (!skill) return { content: `no such skill: ${name}. available: ${names}`, isError: true };
      return { content: await loadSkillBody(skill) };
    },
  });
}
