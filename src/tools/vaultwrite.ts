import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { defineTool } from "./types.ts";

// ponytail: env-configurable because vault layouts differ (test vault uses 100-inbox etc.)
const ALLOWED_DIRS = (process.env.MINERVA_VAULT_WRITE_DIRS
  ?? "000-Meta/minerva,100-Concepts,200-Sources,900-Raw")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
const MODES = ["create", "overwrite", "append"] as const;
type Mode = (typeof MODES)[number];

// Only the leading frontmatter block counts - origin deeper in the file proves nothing.
function hasMinervaOrigin(raw: string): boolean {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return Boolean(m && /^origin:\s*minerva\s*$/m.test(m[1]));
}

// Minerva's own notes must always be identifiable. A note that carries its own
// frontmatter gets the marker spliced into that block - prepending a second
// frontmatter block would corrupt the note, and skipping it (the old behaviour)
// made minerva's notes indistinguishable from human ones and locked her out.
function withOrigin(raw: string): string {
  if (hasMinervaOrigin(raw)) return raw;
  const stamp = `origin: minerva\ntimestamp: ${new Date().toISOString()}\n`;
  const head = /^---\r?\n/.exec(raw);
  if (head) return raw.slice(0, head[0].length) + stamp + raw.slice(head[0].length);
  return `---\n${stamp}---\n\n${raw}`;
}

const vaultWrite = defineTool({
  name: "vault_write",
  description:
    "Writes a .md note into the Obsidian vault. Allowed only under: 000-Meta/minerva, 100-Concepts, 200-Sources, 900-Raw. Human notes (without 'origin: minerva' frontmatter) are never modified in any mode.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "note path relative to vault root" },
      content: { type: "string", description: "markdown content to write" },
      mode: {
        type: "string",
        enum: ["create", "overwrite", "append"],
        description: "'create' (default) fails if file exists unless it is a minerva note; 'overwrite' replaces; 'append' appends with a separator",
      },
    },
    required: ["path", "content"],
  },
  async execute(args) {
    if (!process.env.MINERVA_VAULT) throw new Error("MINERVA_VAULT is not set");
    // ponytail: realpath the root too - macOS maps /var to /private/var
    const root = await realpath(path.resolve(process.env.MINERVA_VAULT));

    const mode: Mode = MODES.includes(args.mode as Mode) ? (args.mode as Mode) : "create";
    if (args.mode !== undefined && !MODES.includes(args.mode as Mode)) {
      throw new Error(`Invalid mode "${args.mode}". Use one of: ${MODES.join(", ")}`);
    }

    // Normalize FIRST, then whitelist - kills ../ traversal before any fs call.
    const rel = String(args.path);
    const norm = path.normalize(rel).replace(/^[\\/]+/, "");
    if (norm.split(/[\\/]/).includes("..")) throw new Error(`Path traversal rejected: ${rel}`);
    if (!norm.endsWith(".md")) throw new Error(`Only .md files are writable, got: ${rel}`);
    const top = norm.split(/[\\/]/).slice(0, 2).join(path.sep);
    if (!ALLOWED_DIRS.some((d) => top === d || top.startsWith(d + path.sep))) {
      throw new Error(`Path not allowed: ${rel}. Allowed target dirs: ${ALLOWED_DIRS.join(", ")}`);
    }

    let abs = path.resolve(root, norm);
    if (!abs.startsWith(root + path.sep)) throw new Error(`Path escapes vault root: ${rel}`);

    // Resolve the deepest EXISTING ancestor and check it BEFORE mkdir - otherwise a
    // symlinked parent gets directories created outside the vault before we refuse.
    let probe = path.dirname(abs);
    while (!(await stat(probe).then(() => true).catch(() => false))) {
      const up = path.dirname(probe);
      if (up === probe) break;
      probe = up;
    }
    const probeReal = await realpath(probe).catch(() => probe);
    if (probeReal !== root && !probeReal.startsWith(root + path.sep)) {
      throw new Error(`Path escapes vault root: ${rel}`);
    }

    await mkdir(path.dirname(abs), { recursive: true });
    abs = path.join(await realpath(path.dirname(abs)), path.basename(abs));
    if (!abs.startsWith(root + path.sep)) throw new Error(`Path escapes vault root: ${rel}`);

    // lstat, not stat: a symlink pointing at a file that does not exist yet reports
    // ENOENT through stat, which used to skip this guard entirely and let writeFile
    // follow the link out of the vault.
    const link = await lstat(abs).then((s) => s.isSymbolicLink()).catch(() => false);
    if (link) throw new Error(`Refusing to write through symlink: ${rel}`);

    const exists = await stat(abs).then(() => true).catch(() => false);
    if (exists) {
      if (!hasMinervaOrigin(await readFile(abs, "utf8"))) {
        throw new Error(`Refusing to modify existing human note without 'origin: minerva' frontmatter: ${rel}`);
      }
    }

    let content = String(args.content);
    // Append onto an existing file is the only case that needs no marker - it is
    // already at the top of that file. Appending to a NEW file does need one.
    if (mode !== "append" || !exists) content = withOrigin(content);

    if (mode === "append") {
      const old = exists ? await readFile(abs, "utf8") : "";
      await writeFile(abs, old + (old ? "\n\n---\n\n" : "") + content);
    } else {
      await writeFile(abs, content);
    }

    return { content: `wrote ${Buffer.byteLength(content)} bytes to ${rel} (mode: ${mode})` };
  },
});

export default vaultWrite;
