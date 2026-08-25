import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types";

export interface Entry {
  ts: number;
  type: string;
  data: unknown;
}

const DEFAULT_ROOT = "./sessions";

function sessionId(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
}

export class Session {
  readonly id: string;

  private readonly file: string;
  private queue: Promise<void> = Promise.resolve();

  private constructor(rootDir: string, id: string) {
    this.id = id;
    this.file = path.join(rootDir, `${id}.jsonl`);
  }

  static async create(rootDir: string = DEFAULT_ROOT): Promise<Session> {
    await mkdir(rootDir, { recursive: true });
    return new Session(rootDir, sessionId());
  }

  static open(rootDir: string, id: string): Session {
    return new Session(rootDir, id);
  }

  async append(type: string, data: unknown): Promise<void> {
    const line = JSON.stringify({ ts: Date.now(), type, data }) + "\n";
    this.queue = this.queue.then(() => appendFile(this.file, line));
    const done = this.queue;
    // one failed write must not poison the chain for later writes
    this.queue = this.queue.catch(() => {});
    await done;
  }

  private async entries(): Promise<Entry[]> {
    const raw = await readFile(this.file, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Entry);
  }

  async messages(): Promise<Message[]> {
    const out: Message[] = [];
    for (const e of await this.entries()) {
      if (e.type === "message") out.push(e.data as Message);
    }
    return out;
  }

  async lastEntry<T>(type: string): Promise<T | undefined> {
    const all = await this.entries();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].type === type) return all[i].data as T;
    }
    return undefined;
  }
}

export async function listSessions(
  rootDir: string = DEFAULT_ROOT,
): Promise<{ id: string }[]> {
  let names: string[];
  try {
    names = await readdir(rootDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => ({ id: n.slice(0, -".jsonl".length) }));
}
