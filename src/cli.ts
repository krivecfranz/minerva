import readline from "node:readline";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { magenta, dim, cyan, green, red } from "./ui/style.ts";
import { Session } from "./core/session.ts";
import { runTurn, tutorSystem } from "./core/agent.ts";
import { runSubAgent, loadAgents } from "./core/subagents.ts";
import { discoverSkills, skillsSystemPrompt, loadSkillBody } from "./core/skills.ts";
import { recordExamResult, topicWeaknesses, examSystemContext } from "./core/exam.ts";
import { newCard, isDue, sortDue, gradeCard, type MinervaCard } from "./core/scheduler.ts";
import { loadStrategies, recordOutcome, strategyRotationHint, STRATEGY_NAMES } from "./core/strategies.ts";
import { readSessionLogs, loadCurrentPrompts, writeProposal, buildRetrospectPrompt } from "./core/retrospect.ts";
import { OpenRouterAdapter } from "./providers/openrouter.ts";
import { OllamaAdapter } from "./providers/ollama.ts";
import { MockAdapter } from "./providers/mock.ts";
import { model as defaultModel } from "./config.ts";
import webFetch from "./tools/webfetch.ts";
import webSearch from "./tools/websearch.ts";
import vaultTools from "./tools/vault.ts";
import vaultWrite from "./tools/vaultwrite.ts";
import youtubeTools from "./tools/youtube.ts";
import type { ToolDef } from "./tools/types.ts";

const tools: ToolDef[] = [webSearch, webFetch, ...youtubeTools];
if (process.env.MINERVA_VAULT) tools.push(...vaultTools, vaultWrite);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
function makeAdapter(p: string) {
  if (p === "ollama") return new OllamaAdapter(ollamaBaseUrl);
  if (p === "mock") return new MockAdapter();
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterAdapter();
  return new MockAdapter();
}
let provider = process.env.MINERVA_PROVIDER ?? "auto";
let adapter = makeAdapter(provider);
let currentModel = process.env.MINERVA_MODEL ?? defaultModel;
async function listOllamaModels(): Promise<string[]> {
  const res = await fetch(`${ollamaBaseUrl}/api/tags`);
  const { models } = (await res.json()) as { models: { name: string }[] };
  return models.map((m) => m.name);
}
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
  if (input.startsWith("/model")) {
    const arg = input.slice(6).trim();
    if (!arg) {
      console.log(cyan(`provider: ${provider} - model: ${currentModel}`));
      if (provider === "ollama") {
        try {
          console.log(dim(`available: ${(await listOllamaModels()).join(", ")}`));
        } catch (e) {
          console.log(red(`could not reach ollama: ${e instanceof Error ? e.message : e}`));
        }
      }
    } else {
      const [maybeProvider, ...rest] = arg.split(":");
      if (rest.length && ["ollama", "openrouter", "mock"].includes(maybeProvider)) {
        provider = maybeProvider;
        adapter = makeAdapter(provider);
        currentModel = rest.join(":");
      } else {
        currentModel = arg;
      }
      console.log(green(`-> provider: ${provider} - model: ${currentModel}`));
    }
    promptSafe();
    continue;
  }
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
  if (input.startsWith("/strat")) {
    // RSI level 3: query/log which explanation strategy works per concept
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no strategies.json location"));
      promptSafe();
      continue;
    }
    const m = /^\/strat(?:log)?\s+(\S+)(?:\s+(\S+)(?:\s+(yes|no))?)?$/.exec(input);
    if (!m) {
      console.log(red("usage: /strat <concept> | /stratlog <concept> <strategy> <yes|no>"));
      console.log(dim(`strategies: ${STRATEGY_NAMES.join(", ")}`));
    } else if (input.startsWith("/stratlog") && m[2] && m[3]) {
      await recordOutcome(vault, m[1], m[2], m[3] === "yes");
      console.log(green(`recorded: ${m[2]} on "${m[1]}" -> ${m[3]}`));
    } else if (input.startsWith("/stratlog")) {
      console.log(red("usage: /stratlog <concept> <strategy> <yes|no>"));
    } else {
      const store = await loadStrategies(vault);
      const hint = strategyRotationHint(store[m[1]], m[1]);
      console.log(hint ?? dim(`no data for "${m[1]}" yet - record outcomes with /stratlog`));
    }
    promptSafe();
    continue;
  }
  if (input === "/retrospect") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no proposals directory"));
      promptSafe();
      continue;
    }
    const agent = agents.find((a) => a.name === "retrospect");
    if (!agent) {
      console.log(red("no retrospect agent found"));
      promptSafe();
      continue;
    }
    console.log(cyan("minerva > analyzing session history..."));
    const [logs, inventory] = await Promise.all([
      readSessionLogs(vault),
      loadCurrentPrompts(["./skills"], "./agents"),
    ]);
    if (!logs.length) {
      console.log(dim("no session logs yet - nothing to analyze"));
      promptSafe();
      continue;
    }
    const { result } = await runSubAgent(adapter, agent, buildRetrospectPrompt(logs, inventory));
    try {
      const p = await writeProposal(vault, `retrospect-${new Date().toISOString().slice(0, 10)}`, result);
      console.log(green(`proposal written: ${p}`));
    } catch (e) {
      console.log(red(`proposal failed: ${e instanceof Error ? e.message : e}`));
    }
    promptSafe();
    continue;
  }
  if (input === "/examstats") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no exams.jsonl location"));
      promptSafe();
      continue;
    }
    const weak = await topicWeaknesses(vault);
    if (!weak.length) console.log(dim("no exam data"));
    else console.table(weak.map((w) => ({ topic: w.topic, correct: Math.round(w.rate * 100) + "%" })));
    // ponytail: re-inject exam context into the system prompt for subsequent turns
    system = tutorSystem(skillsSystemPrompt(skills));
    const ctx = await examSystemContext(vault);
    if (ctx) system += "\n\n" + ctx;
    promptSafe();
    continue;
  }
  if (input.startsWith("/logexam")) {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no exams.jsonl location"));
      promptSafe();
      continue;
    }
    // ponytail: grading stays conversational, this just records the result
    const m = /^\/logexam\s+(\S+)\s+(\d+)\s*\/\s*(\d+)$/.exec(input);
    if (!m || +m[3] < 1 || +m[2] > +m[3]) {
      console.log(red("usage: /logexam <topic> <correct>/<total>"));
    } else {
      await recordExamResult(vault, { topic: m[1], correct: +m[2], total: +m[3], date: new Date().toISOString() });
      console.log(green(`logged ${m[2]}/${m[3]} for ${m[1]}`));
    }
    promptSafe();
    continue;
  }
  process.stdout.write(cyan("minerva > "));
  try {
    for await (const ev of runTurn(adapter, session, history, input, tools, { system, model: currentModel })) {
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
