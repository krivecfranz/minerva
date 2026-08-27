// ponytail: pi-style palette, truecolor with a 16-colour fallback. Still no chalk.
const on = process.stdout.isTTY && !process.env.NO_COLOR;
const truecolor = /truecolor|24bit/.test(process.env.COLORTERM ?? "");

function paint(r: number, g: number, b: number, fallback: number) {
  const seq = truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[${fallback}m`;
  return (s: string) => (on ? `${seq}${s}\x1b[0m` : s);
}

export const olive = paint(201, 204, 106, 33); // signature yellow-green
export const oliveDim = paint(138, 140, 74, 33);
export const purple = paint(150, 90, 210, 35); // input frame
export const blue = paint(74, 158, 221, 36); // box titles
export const grey = paint(110, 110, 110, 90);
export const white = paint(216, 216, 216, 37);
export const red = paint(220, 80, 80, 31);
export const green = paint(120, 200, 120, 32);
export const yellow = paint(212, 212, 102, 33);

// ponytail: old names kept so the 340 lines of cli.ts need no rename pass
export const dim = grey;
export const magenta = purple;
export const cyan = blue;
