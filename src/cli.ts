import readline from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { magenta, dim, cyan, green, red } from "./ui/style.ts";
import { Session } from "./core/session.ts";
import { runTurn, tutorSystem } from "./core/agent.ts";
import { runSubAgent, loadAgents } from "./core/subagents.ts";
import { discoverSkills, skillsSystemPrompt, loadSkillBody } from "./core/skills.ts";
import { newCard, isDue, sortDue, gradeCard, type MinervaCard } from "./core/scheduler.ts";
import { OpenRouterAdapter } from "./providers/openrouter.ts";
import { OllamaAdapter } from "./providers/ollama.ts";
import { MockAdapter } from "./providers/mock.ts";
import webFetch from "./tools/webfetch.ts";
import webSearch from "./tools/websearch.ts";
import vaultTools from "./tools/vault.ts";
import vaultWrite from "./tools/vaultwrite.ts";
import youtubeTools from "./tools/youtube.ts";
import type { ToolDef } from "./tools/types.ts";

const tools: ToolDef[] = [webSearch, webFetch, ...youtubeTools];
if (process.env.MINERVA_VAULT) tools.push(...vaultTools, vaultWrite);
const adapter = (() => {
  const p = process.env.MINERVA_PROVIDER ?? "auto";
  if (p === "ollama") return new OllamaAdapter();
  if (p === "mock") return new MockAdapter();
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterAdapter();
  return new MockAdapter();
})();
const vault = process.env.MINERVA_VAULT ? path.resolve(process.env.MINERVA_VAULT) : undefined;
const deckFile = vault ? path.join(vault, "000-Meta", "minerva", "cards.json") : undefined;

async function loadDeck(): Promise<MinervaCard[]> {
  try {
    return JSON.parse(await readFile(deckFile!, "utf8")) as MinervaCard[];
  } catch {
    return [];
  }
}
async function saveDeck(cards: MinervaCard[]): Promise<void> {
  await mkdir(path.dirname(deckFile!), { recursive: true });
  await writeFile(deckFile!, JSON.stringify(cards, null, 2));
}
if (adapter instanceof MockAdapter) console.log(dim("(mock mode - set OPENROUTER_API_KEY or MINERVA_PROVIDER=ollama)"));

const [session, skills, agents] = await Promise.all([
  Session.create(),
  discoverSkills(["./skills"]),
  loadAgents("./agents", tools),
]);
console.log(dim(`session ${session.id} - tools: ${tools.map((t) => t.name).join(", ")} - agents: ${agents.map((a) => a.name).join(", ")} - skills: ${skills.map((s) => s.name).join(", ")}`));

let history = [];
let system = tutorSystem(skillsSystemPrompt(skills));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: magenta("you > ") });
const promptSafe = () => {
  if (!rl.closed) rl.prompt();
};
promptSafe();

// Review state machine: lives in the same line loop (rl.question conflicts with the iterator).
let review: { deck: MinervaCard[]; queue: MinervaCard[]; phase: "question" | "grade" } | null = null;
const GRADES = { "1": "again", "2": "hard", "3": "good", "4": "easy" } as const;

for await (const line of rl) {
  const input = line.trim();
  if (review) {
    // /skip works in both phases: postpone without revealing/grading
    if (input === "/skip") {
      review.queue.push(review.queue.shift()!);
      if (review.phase === "grade") {
        console.log(dim(`\nQ ${review.queue[0].question}`));
        review.phase = "question";
      }
      continue;
    }
    try {
      if (review.phase === "question") {
        if (input) continue; // only enter reveals the answer
        const card = review.queue[0];
        console.log(`${green("A")} ${card.answer}`);
        console.log(dim("grade: 1=again 2=hard 3=good 4=easy"));
        review.phase = "grade";
      } else {
        const g = GRADES[input as keyof typeof GRADES];
        if (!g) {
          console.log(red("1-4 or /skip?"));
          continue;
        }
        const card = review.queue.shift()!;
        const idx = review.deck.findIndex((c) => c.id === card.id);
        review.deck[idx] = gradeCard(card, g);
        console.log(dim(`-> ${g}, next in ${Math.max(1, Math.round((new Date(review.deck[idx].fsrs.due as unknown as string).getTime() - Date.now()) / 86_400_000))}d`));
      }
    } catch (err) {
      // never lose graded progress: persist what we have and bail out of review
      await saveDeck(review.deck).catch(() => {});
      console.log(red(`review aborted, deck saved: ${err instanceof Error ? err.message : err}`));
      review = null;
      promptSafe();
      continue;
    }
    if (!review.queue.length) {
      await saveDeck(review.deck);
      console.log(green("review done - deck saved"));
      review = null;
      promptSafe();
      continue;
    }
    console.log(`\n${magenta("Q")} ${review.queue[0].question}`);
    review.phase = "question";
    continue;
  }
  if (!input) {
    promptSafe();
    continue;
  }
  if (input === "/exit") break;
  if (input === "/review") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no deck location"));
      promptSafe();
      continue;
    }
    const deck = await loadDeck();
    const due = sortDue(deck).filter((c) => isDue(c));
    if (!due.length) {
      console.log(green("nothing due. deck size: " + deck.length));
      promptSafe();
      continue;
    }
    console.log(cyan(`${due.length} card(s) due.`));
    review = { deck, queue: [...due], phase: "question" };
    console.log(`\n${magenta("Q")} ${review.queue[0].question}`);
    console.log(dim("(enter to reveal, /skip to postpone)"));
    continue;
  }
  if (input === "/research") {
    const researcher = agents.find((a) => a.name === "researcher");
    if (!researcher) {
      console.log(dim("no researcher agent found"));
    } else {
      console.log(cyan("minerva > researching..."));
      const { result } = await runSubAgent(adapter, researcher, process.env.RESEARCH_TASK ?? "Summarize the current state of spaced repetition algorithms.");
      console.log(result);
    }
    promptSafe();
    continue;
  }
  if (input.startsWith("/mkcards")) {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no deck location"));
      promptSafe();
      continue;
    }
    const topic = input.slice(8).trim() || "the last session's material";
    const writer = agents.find((a) => a.name === "card-writer");
    console.log(cyan(`minerva > writing cards about: ${topic}`));
    const { result } = await runSubAgent(adapter, writer!, topic);
    try {
      const parsed = JSON.parse(result.slice(result.indexOf("["), result.lastIndexOf("]") + 1)) as { question: string; answer: string; concept?: string }[];
      const deck = await loadDeck();
      for (const c of parsed) deck.push(newCard(`${Date.now()}-${deck.length}`, c.question, c.answer));
      await saveDeck(deck);
      console.log(green(`added ${parsed.length} cards (deck: ${deck.length})`));
    } catch {
      console.log(red("card-writer returned invalid JSON:\n" + result.slice(0, 400)));
    }
    promptSafe();
    continue;
  }
  process.stdout.write(cyan("minerva > "));
  try {
    for await (const ev of runTurn(adapter, session, history, input, tools, { system })) {
      if (ev.type === "text_delta") process.stdout.write(ev.text);
      else if (ev.type === "tool_start") console.log(dim(`\n[tool] ${ev.call.name}(${ev.call.args.slice(0, 80)})`));
      else {
        history.push(...ev.newMessages);
        process.stdout.write("\n");
        if (ev.usage) console.log(dim(`(${ev.usage.inputTokens} in / ${ev.usage.outputTokens} out)`));
      }
    }
  } catch (err) {
    // recovery ladder: an API error must not kill the session
    // (history stays consistent - only completed messages were pushed)
    console.log(red(`\n[error] ${err instanceof Error ? err.message : err}`));
  }
  promptSafe();
}
