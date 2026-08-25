import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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

    // Escape check BEFORE mkdir so failed writes cannot create dirs outside the vault.
    await mkdir(path.dirname(abs), { recursive: true });
    abs = path.join(await realpath(path.dirname(abs)), path.basename(abs));
    if (!abs.startsWith(root + path.sep)) throw new Error(`Path escapes vault root: ${rel}`);

    const exists = await stat(abs).then(() => true).catch(() => false);
    let isMinervaNote = false;
    if (exists) {
      // Symlinked .md inside allowed dirs must not redirect writes out of the vault.
      if (!(await realpath(abs)).startsWith(root + path.sep)) {
        throw new Error(`Refusing to write through symlink outside vault: ${rel}`);
      }
      isMinervaNote = hasMinervaOrigin(await readFile(abs, "utf8"));
      if (!isMinervaNote) {
        throw new Error(`Refusing to modify existing human note without 'origin: minerva' frontmatter: ${rel}`);
      }
    }

    let content = String(args.content);
    // Keep the origin marker intact across rewrites - otherwise a note loses its
    // minerva identity on the first overwrite and becomes untouchable.
    // (append never needs it: the marker lives at the top of the existing file)
    const needsOrigin = mode !== "append" && (exists ? !hasMinervaOrigin(content) : !content.startsWith("---"));
    if (needsOrigin) {
      content = `---\norigin: minerva\ntimestamp: ${new Date().toISOString()}\n---\n\n${content}`;
    }

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
