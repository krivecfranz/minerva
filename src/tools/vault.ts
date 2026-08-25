import { execFile } from "node:child_process";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { defineTool, type ToolDef } from "./types.ts";

function vaultRoot(): string {
  const root = process.env.MINERVA_VAULT;
  if (!root) throw new Error("MINERVA_VAULT is not set; export it to your Obsidian vault root");
  return path.resolve(root);
}

function insideVault(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes vault root: ${rel}`);
  }
  return abs;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ponytail: naive glob-to-regex (** and * only); enough for vault globs.
function globToRe(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0/g, ".*");
  return new RegExp(`^${esc}$`);
}

const vaultSearch = defineTool({
  name: "vault_search",
  description:
    "Full-text search across .md notes in the Obsidian vault. Returns up to 20 matching file paths relative to the vault root.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "text to search for" },
      glob: { type: "string", description: 'file glob, e.g. "100-Concepts/*.md" (default "**/*.md")' },
    },
    required: ["query"],
  },
  async execute(args) {
    const root = vaultRoot();
    const query = String(args.query);
    const glob = typeof args.glob === "string" ? args.glob : "**/*.md";

    let files: string[] | null = null;
    try {
      const { stdout } = await execFile("rg", ["-l", "--glob", glob, "--", query, root], { maxBuffer: 10 << 20 });
      files = stdout.trim() ? stdout.trim().split("\n") : [];
    } catch (err: any) {
      if (err?.code !== 1) {
        // ponytail: fallback reads every matched note into memory; ceiling ~a few thousand notes.
        const re = globToRe(glob);
        const q = query.toLowerCase();
        files = [];
        for (const f of await walk(root)) {
          if (!re.test(path.relative(root, f).split(path.sep).join("/"))) continue;
          if ((await readFile(f, "utf8")).toLowerCase().includes(q)) files.push(f);
        }
      } else {
        files = []; // rg exit 1: no matches
      }
    }

    const hits = files!
      .slice(0, 20)
      .map((f) => path.relative(root, f))
      .sort();
    return { content: hits.length ? hits.join("\n") : "no matches" };
  },
});

const vaultRead = defineTool({
  name: "vault_read",
  description: "Reads an Obsidian note (.md) by vault-relative path, returned as numbered lines.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "note path relative to vault root" },
      offset: { type: "number", description: "first line to return (1-based)" },
      limit: { type: "number", description: "number of lines (default 200)" },
    },
    required: ["path"],
  },
  async execute(args) {
    const root = await realpath(vaultRoot()); // macOS: /var is a symlink to /private/var
    let abs = insideVault(root, String(args.path)); // trust boundary: never read outside the vault
    abs = await realpath(abs); // symlinks must not escape the vault either
    if (!abs.startsWith(root + path.sep)) throw new Error(`Path escapes vault root: ${args.path}`);
    if (!abs.endsWith(".md")) throw new Error(`Only .md files are readable, got: ${args.path}`);
    const offset = Math.max(1, Math.floor(Number(args.offset) || 1));
    const limit = Math.min(2000, Math.max(1, Math.floor(Number(args.limit) || 200)));
    const lines = (await readFile(abs, "utf8")).split("\n").slice(offset - 1, offset - 1 + limit);
    return { content: lines.map((l, i) => `${offset + i}: ${l}`).join("\n") };
  },
});

// ponytail: recursive count per folder re-walks subtrees; fine at vault scale.
async function tree(dir: string, depth: number, prefix: string, out: string[]): Promise<void> {
  if (out.length >= 80 || depth <= 0) return;
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= 80) return;
    const sub = path.join(dir, e.name);
    out.push(`${prefix}${e.name}/ (${(await walk(sub)).length} notes)`);
    await tree(sub, depth - 1, prefix + "  ", out);
  }
}

const vaultTree = defineTool({
  name: "vault_tree",
  description: "Lists the Obsidian vault folder structure with .md note counts per directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: 'folder relative to vault root (default ".")' },
      depth: { type: "number", description: "how deep to descend (default 2)" },
    },
  },
  async execute(args) {
    const root = vaultRoot();
    const abs = insideVault(root, typeof args.path === "string" ? args.path : ".");
    const depth = Math.min(6, Math.max(1, Math.floor(Number(args.depth) || 2)));
    const out: string[] = [`${(await walk(abs)).length} notes`];
    await tree(abs, depth, "", out);
    return { content: out.slice(0, 80).join("\n") };
  },
});

export default [vaultSearch, vaultRead, vaultTree] satisfies ToolDef[];
