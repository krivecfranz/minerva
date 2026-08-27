import { olive, oliveDim, grey, white, blue } from "./style.ts";

// ponytail: static art, no figlet dependency for six lines of text
const M = [
  "  ██╗     ██╗",
  "  ███╗   ███║",
  "  ████╗ ████║",
  "  ██╔████╔██║",
  "  ██║╚██╔╝██║",
  "  ██║ ╚═╝ ██║",
];

function section(title: string, items: string[], width: number): string {
  if (!items.length) return "";
  const head = blue(`[${title}]`);
  const lines: string[] = [];
  let row = "  ";
  for (const item of items) {
    if (row.length + item.length + 2 > width && row.trim()) {
      lines.push(grey(row.trimEnd().replace(/,$/, "")));
      row = "  ";
    }
    row += item + ", ";
  }
  if (row.trim()) lines.push(grey(row.trimEnd().replace(/,$/, "")));
  return [head, ...lines].join("\n");
}

export function banner(opts: {
  version: string;
  skills: string[];
  tools: string[];
  agents: string[];
  width: number;
}): string {
  const art = M.map((l, i) => (i < 3 ? olive(l) : oliveDim(l))).join("\n");
  const blocks: string[] = [art, "", `${white("minerva")} ${grey("v" + opts.version)}`, ""];
  for (const [title, items] of [
    ["Skills", opts.skills],
    ["Tools", opts.tools],
    ["Subagents", opts.agents],
  ] as const) {
    const s = section(title, items, opts.width);
    if (s) blocks.push(s, "");
  }
  return blocks.join("\n");
}
