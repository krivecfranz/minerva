// ponytail: RSI level 2 - propose improvements, humans apply them. Never auto-write skills.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionLogEntry {
  ts: number;
  summary: string;
}

// ponytail: jsonl with skip-on-garbage lines - logs are disposable, not sacred.
export async function readSessionLogs(vaultRoot: string, limit = 20): Promise<SessionLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(join(vaultRoot, "000-Meta", "minerva", "sessions.jsonl"), "utf8");
  } catch {
    return [];
  }
  const out: SessionLogEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as SessionLogEntry;
      if (typeof o.ts === "number" && typeof o.summary === "string") out.push(o);
    } catch {
      // corrupt line: ignore
    }
  }
  return out.slice(-limit).reverse();
}

// ponytail: own tiny frontmatter parse instead of importing skills.ts - no coupling.
async function skillInventory(dir: string): Promise<string> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const file of files) {
    let raw = "";
    try {
      raw = await readFile(join(dir, file), "utf8");
    } catch {
      continue; // unreadable skill file must not kill the whole inventory
    }
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    const meta: Record<string, string> = {};
    if (m) {
      for (const l of m[1].split("\n")) {
        const i = l.indexOf(":");
        if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
    }
    lines.push(`- ${meta.name ?? file}: ${meta.description ?? "(no description)"}`);
  }
  return lines.join("\n");
}

export async function loadCurrentPrompts(skillsDirs: string[], agentsDir?: string): Promise<string> {
  const parts: string[] = ["# Skill inventory"];
  for (const dir of skillsDirs) {
    const inv = await skillInventory(dir);
    if (inv) parts.push(`## ${dir}\n${inv}`);
  }
  if (agentsDir) {
    const inv = await skillInventory(agentsDir);
    if (inv) parts.push(`## Agents (${agentsDir})\n${inv}`);
  }
  return parts.join("\n\n");
}

// ponytail: slugify hard, refuse overwrite - proposals are append-only history.
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

export async function writeProposal(vaultRoot: string, title: string, body: string): Promise<string> {
  const dir = join(vaultRoot, "000-Meta", "minerva", "proposals");
  await mkdir(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${date}-${slugify(title)}.md`);
  await writeFile(path, `---\norigin: minerva\ntype: proposal\ndate: ${new Date().toISOString()}\nstatus: proposed\n---\n\n# ${title}\n\n${body}\n`, {
    flag: "wx", // throws if exists
  });
  return path;
}

// ponytail: prompt is the whole product here - skeptical, evidence-bound, max 3 changes.
export function buildRetrospectPrompt(logs: SessionLogEntry[], promptInventory: string): string {
  const logText = logs
    .map((l) => `- [${new Date(l.ts).toISOString()}] ${l.summary}`)
    .join("\n");
  return `You are analyzing Minerva's recent learning sessions to improve its skills and prompts.

Recent session summaries (${logs.length} entries):
${logText || "(none)"}

Current skill/prompt inventory:
${promptInventory}

Instructions:
1. Identify recurring struggles or friction across the session summaries. Look for patterns, not one-offs.
2. Propose at most 3 concrete changes to skills or prompts, each written as a diff-style suggestion (before/after snippets).
3. Every proposal MUST cite specific evidence from the logs. No evidence, no proposal.
4. Prefer deleting or trimming over adding new material.
5. NEVER touch Minerva's teaching philosophy core rules - those are off limits.
6. Output ONLY a markdown report with these sections: ## Findings, ## Proposed changes, ## Evidence.`;
}
