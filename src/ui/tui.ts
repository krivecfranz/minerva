import { olive, purple, blue, grey, white } from "./style.ts";

// ponytail: transient bottom chrome, not a full screen buffer - scrollback stays intact.
// The chrome is erased before anything else writes to stdout and redrawn after, so the
// 340 lines of console.log in cli.ts keep working untouched.

const out = process.stdout;
const realWrite = out.write.bind(out);
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface TaskHandle {
  setState(state: string): void;
  done(): void;
}

interface Task {
  name: string;
  state: string;
  started: number;
}

export interface Command {
  name: string;
  hint: string;
}

export interface Status {
  cwd: string;
  provider: string;
  model: string;
  used?: number;
  max?: number;
}

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

// ponytail: strip SGR only - that is all we ever emit
const vis = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vis(s)));

export class Tui {
  private painted = 0;
  private cursorUp = 0; // rows the cursor sits above the last painted row
  private mode: "off" | "input" | "busy" = "off";
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private histIndex = 0;
  private tasks = new Map<number, Task>();
  private nextTask = 1;
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private status: Status;
  private patched = false;
  private commands: Command[] = [];

  constructor(status: Status) {
    this.status = status;
    out.on("resize", () => this.repaint());
  }

  get width(): number {
    // ponytail: one column short of the terminal on purpose. A line that fills the
    // last column arms the terminal's deferred wrap, so the row count goes wrong and
    // erase() leaves debris behind.
    return Math.max(40, Math.min((out.columns || 80) - 1, 120));
  }

  setCommands(list: Command[]): void {
    this.commands = list;
  }

  /** Commands matching what has been typed so far, empty once a full command plus space is there. */
  matches(): Command[] {
    if (!this.buffer.startsWith("/") || this.buffer.includes(" ")) return [];
    const hits = this.commands.filter((c) => c.name.startsWith(this.buffer));
    return hits.length === 1 && hits[0].name === this.buffer ? [] : hits;
  }

  private suggestionLines(): string[] {
    const hits = this.matches().slice(0, 6);
    if (!hits.length) return [];
    const nameW = Math.max(...hits.map((h) => h.name.length));
    const room = this.width - 4 - nameW - 2;
    return hits.map((h) => {
      const hint = h.hint.length > room ? h.hint.slice(0, Math.max(0, room - 1)) + "…" : h.hint;
      return "  " + white(h.name.padEnd(nameW)) + "  " + grey(hint);
    });
  }

  setStatus(patch: Partial<Status>): void {
    this.status = { ...this.status, ...patch };
    this.repaint();
  }

  // --- chrome -------------------------------------------------------------

  private patch(): void {
    if (this.patched) return;
    this.patched = true;
    // ponytail: wrapping stdout beats rewriting every call site
    (out as unknown as { write: typeof realWrite }).write = ((chunk: string, ...rest: unknown[]) => {
      const wasPainted = this.painted > 0;
      if (wasPainted) this.erase();
      const r = (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
      if (wasPainted) this.draw();
      return r;
    }) as typeof realWrite;
  }

  private erase(): void {
    if (!this.painted) return;
    // the cursor may be parked inside the input field, not on the last row
    const up = this.painted - this.cursorUp - 1;
    realWrite(up > 0 ? `\x1b[${up}F` : "\r");
    realWrite("\x1b[0J");
    this.painted = 0;
    this.cursorUp = 0;
  }

  private taskBox(): string[] {
    if (!this.tasks.size) return [];
    const w = this.width;
    const spin = SPINNER[this.frame % SPINNER.length];
    const running = `${this.tasks.size} running`;
    const title = " Subagents ";
    // ┌─ + title + fill + space + running + ─┐  ==  w
    const fillLen = Math.max(1, w - 5 - vis(title) - running.length);
    const lines = [blue("┌─") + blue(title) + blue("─".repeat(fillLen)) + " " + olive(running) + blue("─┐")];
    const inner = w - 4;
    for (const t of this.tasks.values()) {
      const left = `${olive(spin)} ${grey(mmss(Date.now() - t.started))}  ${white(t.name)}`;
      // ponytail: the state is the flexible half - clip it, never the elapsed timer
      const room = inner - vis(left) - 1;
      const state = t.state.length > room ? t.state.slice(0, Math.max(0, room - 1)) + "…" : t.state;
      const right = grey(state);
      const gap = Math.max(1, inner - vis(left) - vis(right));
      lines.push(blue("│") + " " + left + " ".repeat(gap) + right + " " + blue("│"));
    }
    lines.push(blue("└" + "─".repeat(w - 2) + "┘"));
    return lines;
  }

  private inputBox(): string[] {
    const w = this.width;
    const inner = w - 4;
    // ponytail: horizontal window instead of a wrapping multiline editor
    const start = Math.max(0, this.cursor - inner + 1);
    const view = this.buffer.slice(start, start + inner);
    return [
      purple("┌" + "─".repeat(w - 2) + "┐"),
      purple("│") + " " + pad(white(view), inner) + " " + purple("│"),
      purple("└" + "─".repeat(w - 2) + "┘"),
    ];
  }

  private statusLine(): string {
    const w = this.width;
    const s = this.status;
    const left = grey(s.cwd);
    const ctx = s.max
      ? ` • ${((100 * (s.used ?? 0)) / s.max).toFixed(1)}%/${(s.max / 1000).toFixed(0)}k`
      : s.used
        ? ` • ${s.used < 1000 ? s.used : (s.used / 1000).toFixed(1) + "k"} ctx`
        : "";
    const right = grey(s.provider + " ") + olive(s.model) + grey(ctx);
    const gap = Math.max(1, w - vis(left) - vis(right));
    return " " + left + " ".repeat(gap - 1) + right;
  }

  private draw(): void {
    if (!out.isTTY) return;
    const lines = [...this.taskBox()];
    if (this.mode === "input") lines.push(...this.suggestionLines(), ...this.inputBox());
    if (lines.length) lines.push(this.statusLine());
    if (!lines.length) return;

    realWrite(lines.join("\n"));
    this.painted = lines.length;
    this.cursorUp = 0;

    if (this.mode === "input") {
      this.cursorUp = 2; // bottom border + status line
      // cursor back into the field: up past status + bottom border
      const inner = this.width - 4;
      const start = Math.max(0, this.cursor - inner + 1);
      realWrite(`\x1b[2F\x1b[${3 + this.cursor - start}G`);
    }
  }

  private repaint(): void {
    if (this.mode === "off") return;
    this.erase();
    this.draw();
  }

  private tick(on: boolean): void {
    if (on && !this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.repaint();
      }, 120);
      this.timer.unref?.();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // --- subagent tasks -----------------------------------------------------

  task(name: string, state = "starting"): TaskHandle {
    const id = this.nextTask++;
    this.tasks.set(id, { name, state, started: Date.now() });
    if (!out.isTTY) console.log(grey(`[${name}] ${state}`));
    this.patch();
    if (this.mode === "off") this.mode = "busy";
    this.tick(true);
    this.repaint();
    return {
      setState: (s: string) => {
        const t = this.tasks.get(id);
        if (t) t.state = s;
      },
      done: () => {
        this.tasks.delete(id);
        if (!this.tasks.size) {
          this.tick(false);
          if (this.mode === "busy") {
            this.erase();
            this.mode = "off";
          } else {
            this.repaint();
          }
        }
      },
    };
  }

  // --- line editor --------------------------------------------------------

  readLine(): Promise<string | null> {
    if (!process.stdin.isTTY) return this.readPiped();
    this.patch();
    this.mode = "input";
    this.buffer = "";
    this.cursor = 0;
    this.histIndex = this.history.length;
    if (this.tasks.size) this.tick(true);
    this.repaint();

    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    return new Promise((resolve) => {
      const finish = (value: string | null) => {
        stdin.off("data", onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        this.tick(false);
        this.erase();
        this.mode = "off";
        if (value) {
          this.history.push(value);
          realWrite(purple("you > ") + white(value) + "\n");
        }
        resolve(value);
      };

      const onData = (data: Buffer) => {
        const s = data.toString("utf8");
        for (let i = 0; i < s.length; i++) {
          const c = s[i];
          if (c === "\x03") {
            if (!this.buffer) return finish(null); // ctrl+c on an empty line quits
            this.buffer = "";
            this.cursor = 0;
            continue;
          }
          if (c === "\x04") return finish(null);
          if (c === "\r" || c === "\n") return finish(this.buffer.trim());
          if (c === "\t") {
            const hits = this.matches();
            if (hits.length === 1) {
              this.buffer = hits[0].name + " ";
              this.cursor = this.buffer.length;
            } else if (hits.length > 1) {
              // ponytail: complete to the longest common prefix, like a shell
              let prefix = hits[0].name;
              for (const h of hits) while (!h.name.startsWith(prefix)) prefix = prefix.slice(0, -1);
              if (prefix.length > this.buffer.length) {
                this.buffer = prefix;
                this.cursor = prefix.length;
              }
            }
            continue;
          }
          if (c === "\x7f") {
            if (this.cursor > 0) {
              this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
              this.cursor--;
            }
            continue;
          }
          if (c === "\x1b" && s[i + 1] === "[") {
            const code = s[i + 2];
            i += 2;
            if (code === "D") this.cursor = Math.max(0, this.cursor - 1);
            else if (code === "C") this.cursor = Math.min(this.buffer.length, this.cursor + 1);
            else if (code === "A") this.recall(-1);
            else if (code === "B") this.recall(1);
            else if (code === "H") this.cursor = 0;
            else if (code === "F") this.cursor = this.buffer.length;
            continue;
          }
          if (c < " ") continue; // ponytail: ignore the rest of the control range
          this.buffer = this.buffer.slice(0, this.cursor) + c + this.buffer.slice(this.cursor);
          this.cursor++;
        }
        this.repaint();
      };

      stdin.on("data", onData);
    });
  }

  // ponytail: keeps `echo x | npm start` and the test runner working
  private piped = "";
  private pipedEnded = false;
  private readPiped(): Promise<string | null> {
    const stdin = process.stdin;
    const take = (): string | null => {
      const i = this.piped.indexOf("\n");
      if (i === -1) return null;
      const line = this.piped.slice(0, i);
      this.piped = this.piped.slice(i + 1);
      return line.trim();
    };
    const ready = take();
    if (ready !== null) return Promise.resolve(ready);
    if (this.pipedEnded) return Promise.resolve(this.piped.trim() || null);

    return new Promise((resolve) => {
      const onData = (d: Buffer) => {
        this.piped += d.toString("utf8");
        const line = take();
        if (line !== null) {
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          resolve(line);
        }
      };
      const onEnd = () => {
        this.pipedEnded = true;
        stdin.off("data", onData);
        stdin.off("end", onEnd);
        resolve(this.piped.trim() || null);
      };
      stdin.on("data", onData);
      stdin.on("end", onEnd);
      stdin.resume();
    });
  }

  private recall(dir: number): void {
    const next = this.histIndex + dir;
    if (next < 0 || next > this.history.length) return;
    this.histIndex = next;
    this.buffer = this.history[next] ?? "";
    this.cursor = this.buffer.length;
  }

  close(): void {
    this.tick(false);
    this.erase();
    this.mode = "off";
    if (this.patched) {
      (out as unknown as { write: typeof realWrite }).write = realWrite;
      this.patched = false;
    }
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

export { vis as visibleWidth, mmss as formatElapsed };
