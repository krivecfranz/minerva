// ponytail: 3 ANSI helpers, no chalk. Grow only when the real TUI lands (M1+).
const on = process.stdout.isTTY && !process.env.NO_COLOR;
export const dim = (s: string) => (on ? `\x1b[2m${s}\x1b[0m` : s);
export const magenta = (s: string) => (on ? `\x1b[35m${s}\x1b[0m` : s);
export const cyan = (s: string) => (on ? `\x1b[36m${s}\x1b[0m` : s);
export const green = (s: string) => (on ? `\x1b[32m${s}\x1b[0m` : s);
export const red = (s: string) => (on ? `\x1b[31m${s}\x1b[0m` : s);
