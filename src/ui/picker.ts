import readline from "node:readline";
import { dim, cyan, magenta } from "./style.ts";

export interface PickOption {
  category: string;
  title: string;
  value: { provider: string; model: string };
}

// ponytail: subsequence match, not a real fuzzy scorer like fuzzysort - good enough for a few hundred model names.
export function fuzzyScore(needle: string, haystack: string): number | null {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  let hi = 0;
  let score = 0;
  for (const ch of needle.toLowerCase()) {
    const idx = h.indexOf(ch, hi);
    if (idx === -1) return null;
    score += idx - hi;
    hi = idx + 1;
  }
  return score;
}

const MAX_VISIBLE = 20;

// Same UX as opencode's model dialog (arrow keys, live fuzzy filter, Enter/Esc) without pulling in its TUI stack.
export async function pickModel(options: PickOption[]): Promise<PickOption["value"] | null> {
  if (!process.stdin.isTTY || !options.length) return null;

  return new Promise((resolve) => {
    let query = "";
    let selected = 0;
    let lastLines = 0;
    const wasRaw = process.stdin.isRaw ?? false;
    // the outer readline interface owns a "keypress" listener for its own line editing -
    // steal stdin from it for the duration of the picker, then hand it back.
    const ownedListeners = process.stdin.listeners("keypress") as Array<(str: string, key: readline.Key) => void>;
    for (const l of ownedListeners) process.stdin.removeListener("keypress", l);

    const filtered = () =>
      options
        .map((o) => ({ o, s: fuzzyScore(query, `${o.title} ${o.category}`) }))
        .filter((x): x is { o: PickOption; s: number } => x.s !== null)
        .sort((a, b) => a.s - b.s)
        .map((x) => x.o)
        .slice(0, MAX_VISIBLE);

    function render() {
      const items = filtered();
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
      const rows = [magenta("model > ") + query + dim("_")];
      items.forEach((opt, i) => {
        const line = `${i === selected ? cyan("> ") : "  "}${opt.title} ${dim(`(${opt.category})`)}`;
        rows.push(i === selected ? `\x1b[7m${line}\x1b[0m` : line);
      });
      if (!items.length) rows.push(dim("no matches"));
      rows.push(dim("enter=select  esc=cancel"));

      if (lastLines) process.stdout.write(`\x1b[${lastLines}A\x1b[0J`);
      process.stdout.write(rows.join("\n") + "\n");
      lastLines = rows.length;
    }

    function cleanup() {
      process.stdin.removeListener("keypress", onKeypress);
      for (const l of ownedListeners) process.stdin.on("keypress", l);
      process.stdin.setRawMode(wasRaw);
    }

    function onKeypress(str: string, key: readline.Key) {
      const items = filtered();
      if (key.name === "up") selected = (selected - 1 + items.length) % Math.max(1, items.length);
      else if (key.name === "down") selected = (selected + 1) % Math.max(1, items.length);
      else if (key.name === "return") {
        cleanup();
        resolve(items[selected]?.value ?? null);
        return;
      } else if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        cleanup();
        resolve(null);
        return;
      } else if (key.name === "backspace") {
        query = query.slice(0, -1);
        selected = 0;
      } else if (str && !key.ctrl && !key.meta && str.length === 1) {
        query += str;
        selected = 0;
      }
      render();
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKeypress);
    render();
  });
}
