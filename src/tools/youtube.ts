import { execFile } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDef, type ToolResult } from "./types.ts";

const YT_URL = /^https:\/\/(www\.youtube\.com\/watch\?|youtu\.be\/|m\.youtube\.com\/watch\?)/;

function isYoutubeUrl(url: string): boolean {
  try {
    return YT_URL.test(new URL(url).href);
  } catch {
    return false;
  }
}

function run(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { code?: string | number };
          if (e.code === "ENOENT") return reject(Object.assign(e, { enoent: true }));
          reject(new Error(`${bin} failed: ${stderr.slice(0, 300) || e.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

// ponytail: oembed fallback has no duration/description; that's the ceiling.
async function oembedInfo(url: string): Promise<ToolResult> {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`youtube_info failed: oembed HTTP ${res.status}`);
  const data = (await res.json()) as { title?: string; author_name?: string };
  return {
    content: [
      `# ${data.title ?? "(untitled)"}`,
      `- Channel: ${data.author_name ?? "unknown"}`,
      `- Duration: n/a (oembed fallback; yt-dlp not installed)`,
      "",
    ].join("\n"),
  };
}

function fmtDuration(seconds: unknown): string {
  const s = typeof seconds === "number" ? Math.round(seconds) : null;
  if (s === null || !Number.isFinite(s)) return "unknown";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const youtubeInfo = defineTool({
  name: "youtube_info",
  description:
    "Returns metadata (title, channel, duration, description excerpt) for a YouTube URL. Use before youtube_transcript to check availability.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "YouTube watch URL" } },
    required: ["url"],
  },
  async execute(args): Promise<ToolResult> {
    const url = String(args.url);
    if (!isYoutubeUrl(url)) throw new Error(`Not an https youtube.com/youtu.be URL: ${url}`);

    let meta: Record<string, any>;
    try {
      meta = JSON.parse(await run("yt-dlp", ["--dump-json", url], 30_000));
    } catch (err) {
      if ((err as { enoent?: boolean }).enoent) return oembedInfo(url);
      throw err;
    }

    return {
      content: [
        `# ${meta.title}`,
        `- Channel: ${meta.uploader ?? meta.channel ?? "unknown"}`,
        `- Duration: ${fmtDuration(meta.duration)}`,
        "",
        String(meta.description ?? "").slice(0, 200),
      ].join("\n"),
    };
  },
});

// Dedupes rolling auto-sub lines; also drops cue metadata/headers/empty lines.
export function parseVtt(vtt: string): string {
  // ponytail: rolling auto-subs repeat the previous line, so only a short window
  // is deduped. A global set also swallowed genuine repetition in the talk.
  const WINDOW = 3;
  const out: string[] = [];
  for (const raw of vtt.split("\n")) {
    const line = raw
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!line) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE\b|STYLE\b|REGION\b)/i.test(line)) continue;
    if (/-->/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    if (out.slice(-WINDOW).includes(line)) continue;
    out.push(line);
  }
  return out.join(" ");
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "...[truncated]";
}

const youtubeTranscript = defineTool({
  name: "youtube_transcript",
  description:
    'Fetches the transcript/subtitles of a YouTube video as plain text. Args: url, lang (default "en"), maxChars (default 12000).',
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "YouTube watch URL" },
      lang: { type: "string", description: 'subtitle language, e.g. "en" or "de"' },
      maxChars: { type: "number", description: "max characters returned (default 12000)" },
    },
    required: ["url"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const url = String(args.url);
    if (!isYoutubeUrl(url)) throw new Error(`Not an https youtube.com/youtu.be URL: ${url}`);
    const lang = typeof args.lang === "string" && args.lang ? args.lang : "en";
    const maxChars = typeof args.maxChars === "number" && args.maxChars > 0 ? args.maxChars : 12_000;

    // ponytail: mkdtemp per call - a shared wiped dir races concurrent transcripts.
    const { mkdtemp } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "minerva-yt-"));
    const template = join(dir, "yt-%(id)s.%(ext)s");

    try {
      await run(
        "yt-dlp",
        [
          "--skip-download",
          "--write-auto-subs",
          "--write-subs",
          "--sub-langs",
          lang,
          "--sub-format",
          "vtt",
          "-o",
          template,
          url,
        ],
        60_000,
      );

      const files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
      if (!files.length) {
        return {
          content:
            `No subtitles found for lang="${lang}". Try youtube_info to check the video, another lang, or note that this video may only have manual captions in other languages.`,
          isError: false,
        };
      }

      const vtt = await readFile(join(dir, files[0]), "utf8");
      return { content: truncate(parseVtt(vtt), maxChars) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
});

const tools: ToolDef[] = [youtubeInfo, youtubeTranscript];
export default tools;
