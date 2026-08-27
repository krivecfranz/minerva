// ponytail: two-phase skill loading, claude-code/pi style
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  path: string;
}

const SKILL_FILE = "SKILL.md";
const MAX_DEPTH = 3;

function parseSkillFile(raw: string, path: string): Skill | undefined {
  // ponytail: simple key: value frontmatter, no nested yaml
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return undefined;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    // ponytail: strip the quotes a quoted yaml scalar leaves behind
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["'](.*)["']$/, "$1");
  }
  const { name, description } = meta;
  if (!name || !description) return undefined;
  return { name, description, body: match[2].trim(), path };
}

async function findSkillFiles(dir: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // ponytail: missing dirs skipped silently
  }
  const found: string[] = [];
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) found.push(...(await findSkillFiles(p, depth + 1)));
    } else if (entry.isFile() && entry.name === SKILL_FILE) {
      found.push(p);
    }
  }
  return found;
}

export async function discoverSkills(dirs: string[]): Promise<Skill[]> {
  const byName = new Map<string, Skill>(); // ponytail: first wins on dedupe
  for (const dir of dirs) {
    for (const path of await findSkillFiles(dir, 0)) {
      const skill = parseSkillFile(await readFile(path, "utf8"), path);
      if (skill && !byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadSkillBody(skill: Skill): Promise<string> {
  // ponytail: body already parsed at discover time; lazy re-read is overkill
  return skill.body;
}

export function skillsSystemPrompt(skills: Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  // ponytail: no per-entry truncation budget yet, add when listings get big
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return `# Available skills\nLoad a skill when relevant by calling the load_skill tool.\n${lines.join("\n")}`;
}
