import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// ponytail: this tool is the only thing standing between the model and the user's
// notes. It had two escape holes and a self-lockout; each gets a test here.

const root = await mkdtemp(path.join(tmpdir(), "minerva-vault-"));
const outside = await mkdtemp(path.join(tmpdir(), "minerva-outside-"));
process.env.MINERVA_VAULT = root;
process.env.MINERVA_VAULT_WRITE_DIRS = "100-Concepts";
await mkdir(path.join(root, "100-Concepts"), { recursive: true });

const { default: vaultWrite } = await import("../src/tools/vaultwrite.ts");
const write = (p: string, content: string, mode?: string) =>
  vaultWrite.execute({ path: p, content, ...(mode ? { mode } : {}) }, {});
const exists = (p: string) => stat(p).then(() => true).catch(() => false);

test("refuses to write through a dangling symlink out of the vault", async () => {
  const target = path.join(outside, "pwned.md");
  await symlink(target, path.join(root, "100-Concepts", "evil.md"));
  await assert.rejects(() => write("100-Concepts/evil.md", "geklaut"), /symlink/i);
  assert.equal(await exists(target), false, "nothing may be created outside the vault");
});

test("creates no directories outside the vault when the parent is a symlink", async () => {
  await symlink(outside, path.join(root, "100-Concepts", "linked"));
  await assert.rejects(() => write("100-Concepts/linked/a/b/note.md", "x"), /escapes vault root/i);
  assert.equal(await exists(path.join(outside, "a")), false, "mkdir must not run before the check");
});

test("a note with its own frontmatter still gets the origin marker", async () => {
  const rel = "100-Concepts/kettenregel.md";
  await write(rel, "---\ntitle: Kettenregel\ntags: [analysis]\n---\n\nDie Kettenregel...");
  const raw = await readFile(path.join(root, rel), "utf8");
  assert.match(raw, /^---\r?\norigin: minerva/, "marker belongs inside the existing block");
  assert.match(raw, /title: Kettenregel/, "the note's own frontmatter survives");
  assert.equal(raw.match(/^---$/gm)?.length, 2, "exactly one frontmatter block");
  // and minerva must still be able to edit her own note afterwards
  await write(rel, "---\ntitle: Kettenregel\n---\n\nueberarbeitet", "overwrite");
});

test("append to a new file marks it, so a second append still works", async () => {
  const rel = "100-Concepts/journal.md";
  await write(rel, "Erste Zeile", "append");
  assert.match(await readFile(path.join(root, rel), "utf8"), /origin: minerva/);
  await write(rel, "Zweite Zeile", "append");
  const raw = await readFile(path.join(root, rel), "utf8");
  assert.match(raw, /Erste Zeile/);
  assert.match(raw, /Zweite Zeile/);
});

test("human notes stay untouchable and traversal is rejected", async () => {
  const human = path.join(root, "100-Concepts", "meins.md");
  await writeFile(human, "meine handschriftliche notiz");
  await assert.rejects(() => write("100-Concepts/meins.md", "kaputt", "overwrite"), /human note/i);
  assert.equal(await readFile(human, "utf8"), "meine handschriftliche notiz");
  await assert.rejects(() => write("../../etc/evil.md", "x"), /traversal|not allowed/i);
  await assert.rejects(() => write("300-school/fremd.md", "x"), /not allowed/i);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
