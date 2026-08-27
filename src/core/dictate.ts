import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Tui } from "../ui/tui.ts";
import { red, grey } from "../ui/style.ts";

// ponytail: ffmpeg + whisper are already on this machine - no sox, no API key, no streaming
// protocol. Record to a temp wav, transcribe when the user stops. Offline, free, ~2-4s.

const LANG = process.env.MINERVA_DICTATE_LANG ?? "de";
const MODEL = process.env.MINERVA_WHISPER_MODEL ?? "base";
const DEVICE = process.env.MINERVA_AUDIO_DEVICE ?? ":0"; // avfoundation: no video, audio 0

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const onData = (d: Buffer) => {
      if (d.includes(0x0d) || d.includes(0x0a) || d.includes(0x03)) {
        stdin.off("data", onData);
        if (stdin.isTTY) stdin.setRawMode(false);
        resolve();
      }
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

function exec(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", () => resolve({ code: 127, stderr: `${cmd} not found` }));
    p.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export async function dictate(tui: Tui): Promise<string | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "minerva-dictate-"));
  const wav = path.join(dir, "take.wav");
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  const rec = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", DEVICE, "-ac", "1", "-ar", "16000", "-y", wav], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let recErr = "";
  rec.stderr.on("data", (d) => (recErr += d.toString()));

  let spawnFailed = false;
  rec.on("error", () => (spawnFailed = true));

  const task = tui.task("dictate", "listening — Enter stoppt");
  await waitForEnter();

  if (spawnFailed) {
    task.done();
    await cleanup();
    console.log(red("ffmpeg nicht gefunden"));
    return null;
  }

  // ponytail: 'q' on stdin makes ffmpeg finalise the wav header; SIGTERM would truncate it
  rec.stdin.write("q");
  rec.stdin.end();
  await new Promise((r) => rec.on("close", r));

  if (recErr.includes("Permission") || recErr.includes("Input/output error")) {
    task.done();
    await cleanup();
    console.log(red("Mikrofon nicht erreichbar.") + " Terminal in Systemeinstellungen > Datenschutz > Mikrofon freigeben.");
    console.log(grey(recErr.trim().slice(0, 200)));
    return null;
  }

  task.setState(`transkribiere (${MODEL})…`);
  const res = await exec("whisper", [wav, "--model", MODEL, "--language", LANG, "--output_format", "txt", "--output_dir", dir, "--fp16", "False", "--verbose", "False"]);
  task.done();

  if (res.code === 127) {
    await cleanup();
    console.log(red("whisper nicht gefunden") + " (pip install -U openai-whisper)");
    return null;
  }

  let text = "";
  try {
    text = (await readFile(path.join(dir, "take.txt"), "utf8")).trim();
  } catch {
    await cleanup();
    console.log(red("whisper lieferte kein Transkript"));
    console.log(grey(res.stderr.trim().slice(0, 300)));
    return null;
  }
  await cleanup();
  return text || null;
}
