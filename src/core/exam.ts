// ponytail: append-only JSONL of exam results per topic, aggregated lazily
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

export interface ExamResult {
  topic: string;
  correct: number;
  total: number;
  date: string;
}

const dir = (vaultRoot: string) => join(vaultRoot, "000-Meta", "minerva");
const file = (vaultRoot: string) => join(dir(vaultRoot), "exams.jsonl");

export async function recordExamResult(vaultRoot: string, r: ExamResult): Promise<void> {
  await mkdir(dir(vaultRoot), { recursive: true });
  await appendFile(file(vaultRoot), JSON.stringify(r) + "\n", "utf8");
}

async function readResults(vaultRoot: string): Promise<ExamResult[]> {
  try {
    const raw = await readFile(file(vaultRoot), "utf8");
    // ponytail: tolerate corrupt lines, keep the rest
    return raw.split("\n").filter(Boolean).flatMap((l) => {
      try {
        const r = JSON.parse(l) as ExamResult;
        if (typeof r.topic !== "string" || !Number.isFinite(+r.correct) || !Number.isFinite(+r.total)) return [];
        return [{ topic: r.topic, correct: +r.correct, total: +r.total, date: String(r.date ?? "") }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export async function topicWeaknesses(
  vaultRoot: string,
  minQuestions = 5,
): Promise<{ topic: string; rate: number }[]> {
  const agg = new Map<string, { c: number; t: number }>();
  for (const r of await readResults(vaultRoot)) {
    const a = agg.get(r.topic) ?? { c: 0, t: 0 };
    a.c += r.correct;
    a.t += r.total;
    agg.set(r.topic, a);
  }
  return [...agg]
    .filter(([, a]) => a.t >= minQuestions)
    .map(([topic, a]) => ({ topic, rate: a.c / a.t }))
    .sort((x, y) => x.rate - y.rate);
}

export async function examSystemContext(vaultRoot: string): Promise<string | undefined> {
  const weak = await topicWeaknesses(vaultRoot);
  if (!weak.length) return undefined;
  return `Known weak topics (prioritize these in drills): ${weak.map((w) => `${w.topic} (${Math.round(w.rate * 100)}%)`).join(", ")}`;
}
