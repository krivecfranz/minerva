import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { magenta, dim, cyan, green, red, olive, white, grey } from "./ui/style.ts";
import { Tui } from "./ui/tui.ts";
import { banner } from "./ui/banner.ts";
import { dictate } from "./core/dictate.ts";
import { loadSkillTool } from "./tools/loadskill.ts";
import { Session } from "./core/session.ts";
import { runTurn, tutorSystem } from "./core/agent.ts";
import { runSubAgent, loadAgents } from "./core/subagents.ts";
import { discoverSkills, skillsSystemPrompt, loadSkillBody } from "./core/skills.ts";
import { recordExamResult, topicWeaknesses, examSystemContext } from "./core/exam.ts";
import { newCard, isDue, sortDue, interleave, gradeCard, type MinervaCard } from "./core/scheduler.ts";
import { loadStrategies, recordOutcome, strategyRotationHint, STRATEGY_NAMES } from "./core/strategies.ts";
import { readSessionLogs, loadCurrentPrompts, writeProposal, buildRetrospectPrompt } from "./core/retrospect.ts";
import { recordSessionLog, updateMastery } from "./core/learner.ts";
import { OpenRouterAdapter } from "./providers/openrouter.ts";
import { OllamaAdapter } from "./providers/ollama.ts";
import { MockAdapter } from "./providers/mock.ts";
import { model as defaultModel } from "./config.ts";
import { pickModel, type PickOption } from "./ui/picker.ts";
import webFetch from "./tools/webfetch.ts";
import webSearch from "./tools/websearch.ts";
import vaultTools from "./tools/vault.ts";
import vaultWrite from "./tools/vaultwrite.ts";
import youtubeTools from "./tools/youtube.ts";
import type { ToolDef } from "./tools/types.ts";

const tools: ToolDef[] = [webSearch, webFetch, ...youtubeTools];
if (process.env.MINERVA_VAULT) tools.push(...vaultTools, vaultWrite);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
const lmstudioBaseUrl = process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
const nvidiaBaseUrl = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
function makeAdapter(p: string) {
  if (p === "ollama") return new OllamaAdapter(ollamaBaseUrl);
  if (p === "openrouter") {
    if (process.env.OPENROUTER_API_KEY) return new OpenRouterAdapter();
    console.log(red("OPENROUTER_API_KEY fehlt - faellt auf mock zurueck"));
    return new MockAdapter();
  }
  if (p === "lmstudio") return new OpenRouterAdapter(lmstudioBaseUrl);
  if (p === "nvidia") return new OpenRouterAdapter(nvidiaBaseUrl, process.env.NVIDIA_API_KEY);
  if (p === "mock") return new MockAdapter();
  if (process.env.OPENROUTER_API_KEY) return new OpenRouterAdapter();
  return new MockAdapter();
}
let provider = process.env.MINERVA_PROVIDER ?? "auto";
let adapter = makeAdapter(provider);
let currentModel = process.env.MINERVA_MODEL ?? defaultModel;
const PROVIDERS = ["ollama", "lmstudio", "nvidia", "mock", "openrouter"];

// ponytail: 1.5s timeout per source - an unreachable local server must not hang the picker
async function listModels(category: string, url: string, key: "models" | "data", field: string): Promise<PickOption[]> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as Record<string, { name?: string; id?: string }[]>;
    return (body[key] ?? []).map((m) => ({
      category,
      title: (m as Record<string, string>)[field],
      value: { provider: category, model: (m as Record<string, string>)[field] },
    }));
  } catch {
    return [];
  }
}
const listOllamaModels = () => listModels("ollama", `${ollamaBaseUrl}/api/tags`, "models", "name");
const listLmStudioModels = () => listModels("lmstudio", `${lmstudioBaseUrl}/models`, "data", "id");
const listOpenRouterModels = () => listModels("openrouter", "https://openrouter.ai/api/v1/models", "data", "id");
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

const [session, skills] = await Promise.all([Session.create(), discoverSkills(["./skills"])]);
// load_skill has to exist before the subagents are built - loadAgents filters out
// tool names it does not know, so an agent declaring it would silently lose it.
tools.push(loadSkillTool(skills));
const agents = await loadAgents("./agents", tools);
const termWidth = Math.max(40, Math.min(process.stdout.columns || 80, 120));
console.log(banner({
  version: "0.0.1",
  skills: skills.map((s) => s.name),
  tools: tools.map((t) => t.name),
  agents: agents.map((a) => a.name),
  width: termWidth,
}));
console.log(grey(`session ${session.id}`) + "\n");

let history = [];
let activeSkill: string | null = null;
let activeSkillBody = "";
// ponytail: every rebuild goes through here - /examstats and /retrospect used to
// reset the prompt and drop the loaded skill protocol without telling anyone.
const rebuildSystem = () =>
  tutorSystem(skillsSystemPrompt(skills)) +
  (activeSkill ? `\n\n# Active skill: ${activeSkill}\n${activeSkillBody}` : "");
let system = rebuildSystem();
const tui = new Tui({
  cwd: process.cwd().replace(process.env.HOME ?? "", "~"),
  provider,
  model: currentModel,
});

// ponytail: one list, two consumers - /help prints it, the editor suggests from it
const COMMANDS = [
  { name: "/skill", hint: "Lehr-Protokoll aktivieren - /skill <name>, /skill off, ohne Argument: Liste" },
  { name: "/dictate", hint: "Sprechen statt tippen, lokal ueber Whisper" },
  { name: "/model", hint: "Modell wechseln - ohne Argument interaktiver Picker" },
  { name: "/review", hint: "faellige Karten wiederholen" },
  { name: "/mkcards", hint: "Karten aus dem Stoff erzeugen - /mkcards <thema>" },
  { name: "/research", hint: "Researcher-Subagent starten - /research <thema>" },
  { name: "/agent", hint: "beliebigen Subagenten starten - /agent <name> <auftrag>" },
  { name: "/strat", hint: "Erklaerstrategien zu einem Konzept abfragen" },
  { name: "/stratlog", hint: "Ergebnis einer Strategie protokollieren - <konzept> <strategie> <yes|no>" },
  { name: "/retrospect", hint: "Selbstverbesserungs-Lauf ueber die Session-Logs" },
  { name: "/examstats", hint: "Pruefungsstatistik anzeigen" },
  { name: "/logexam", hint: "Ergebnis eintragen - /logexam <thema> <richtig>/<gesamt>" },
  { name: "/help", hint: "diese Liste" },
  { name: "/exit", hint: "beenden - Ctrl+C auf leerer Zeile tut dasselbe" },
];
tui.setCommands(COMMANDS);

// Review state machine: lives in the same line loop (rl.question conflicts with the iterator).
let review: { deck: MinervaCard[]; queue: MinervaCard[]; phase: "question" | "grade" } | null = null;
const GRADES = { "1": "again", "2": "hard", "3": "good", "4": "easy" } as const;

while (true) {
  const line = await tui.readLine();
  if (line === null) break;
  let input = line.trim();
  if (input === "/dictate") {
    const spoken = await dictate(tui);
    if (!spoken) continue;
    console.log(magenta("you > ") + white(spoken));
    input = spoken;
  }
  if (review) {
    // /skip works in both phases: postpone without revealing/grading
    if (input === "/skip") {
      review.queue.push(review.queue.shift()!);
      review.phase = "question";
      console.log(`\n${magenta("Q")} ${review.queue[0].question}`);
      console.log(dim("(enter to reveal, /skip to postpone)"));
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
        if (vault && card.concept) {
          const mastery = { again: 0.1, hard: 0.4, good: 0.75, easy: 1 }[g];
          await updateMastery(vault, "review", card.concept, { mastery, confidence: 0.5 }, `card ${card.id} graded ${g}`).catch(() => {});
        }
        console.log(dim(`-> ${g}, next in ${Math.max(1, Math.round((new Date(review.deck[idx].fsrs.due as unknown as string).getTime() - Date.now()) / 86_400_000))}d`));
      }
    } catch (err) {
      // never lose graded progress: persist what we have and bail out of review
      await saveDeck(review.deck).catch(() => {});
      console.log(red(`review aborted, deck saved: ${err instanceof Error ? err.message : err}`));
      review = null;
      continue;
    }
    if (!review.queue.length) {
      await saveDeck(review.deck);
      console.log(green("review done - deck saved"));
      review = null;
      continue;
    }
    console.log(`\n${magenta("Q")} ${review.queue[0].question}`);
    review.phase = "question";
    continue;
  }
  if (!input) {
    continue;
  }
  if (input === "/exit") break;
  if (input === "/help" || input === "/?") {
    console.log(cyan("[Commands]"));
    for (const c of COMMANDS) console.log("  " + white(c.name.padEnd(12)) + grey(c.hint));
    continue;
  }
  const skillCmd = /^\/skills?\b\s*(.*)$/.exec(input);
  if (skillCmd) {
    const name = skillCmd[1].trim();
    if (!name || name === "list") {
      console.log(cyan("[Skills]"));
      for (const s of skills) console.log("  " + white(s.name.padEnd(12)) + grey(s.description.slice(0, 90)));
      console.log(grey(activeSkill ? `aktiv: ${activeSkill}` : "keiner aktiv - /skill <name> aktiviert einen"));
    } else if (name === "off") {
      activeSkill = null;
      activeSkillBody = "";
      system = rebuildSystem();
      console.log(green("skill deaktiviert"));
    } else {
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        console.log(red(`kein skill "${name}"`) + grey(` - vorhanden: ${skills.map((s) => s.name).join(", ")}`));
      } else {
        const body = await loadSkillBody(skill);
        activeSkill = skill.name;
        activeSkillBody = body;
        system = rebuildSystem();
        console.log(green(`skill aktiv: ${skill.name}`) + grey(` (${body.length} zeichen protokoll)`));
      }
    }
    continue;
  }
  if (input.startsWith("/model")) {
    const arg = input.slice(6).trim();
    if (!arg) {
      console.log(dim(`current: ${provider}:${currentModel} - looking for local + remote models...`));
      const [ollama, lmstudio, openrouter] = await Promise.all([
        listOllamaModels(),
        listLmStudioModels(),
        listOpenRouterModels(),
      ]);
      const picked = await pickModel([...ollama, ...lmstudio, ...openrouter]);
      if (picked) {
        provider = picked.provider;
        adapter = makeAdapter(provider);
        // ponytail: if the adapter fell back, say so - the status bar must not claim otherwise
        if (adapter instanceof MockAdapter && provider !== "mock") provider = "mock";
        currentModel = picked.model;
        tui.setStatus({ provider, model: currentModel });
        console.log(green(`-> provider: ${provider} - model: ${currentModel}`));
      } else {
        console.log(dim("cancelled"));
      }
    } else {
      const [maybeProvider, ...rest] = arg.split(":");
      if (rest.length && PROVIDERS.includes(maybeProvider)) {
        provider = maybeProvider;
        adapter = makeAdapter(provider);
        // ponytail: if the adapter fell back, say so - the status bar must not claim otherwise
        if (adapter instanceof MockAdapter && provider !== "mock") provider = "mock";
        currentModel = rest.join(":");
      } else {
        currentModel = arg;
      }
      tui.setStatus({ provider, model: currentModel });
      console.log(green(`-> provider: ${provider} - model: ${currentModel}`));
    }
    continue;
  }
  if (input === "/review") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no deck location"));
      continue;
    }
    const deck = await loadDeck();
    const due = sortDue(deck).filter((c) => isDue(c));
    if (!due.length) {
      console.log(green("nothing due. deck size: " + deck.length));
      continue;
    }
    console.log(cyan(`${due.length} card(s) due.`));
    review = { deck, queue: interleave(due), phase: "question" };
    console.log(`\n${magenta("Q")} ${review.queue[0].question}`);
    console.log(dim("(enter to reveal, /skip to postpone)"));
    continue;
  }
  if (input === "/agent" || input.startsWith("/agent ")) {
    const rest = input.slice(6).trim();
    const [name, ...taskWords] = rest.split(/\s+/);
    const agent = name ? agents.find((a) => a.name === name) : undefined;
    if (!agent) {
      console.log(name ? red(`kein subagent "${name}"`) : red("usage: /agent <name> <auftrag>"));
      console.log(dim(`vorhanden: ${agents.map((a) => a.name).join(", ")}`));
      continue;
    }
    const task = taskWords.join(" ");
    if (!task) {
      console.log(red(`usage: /agent ${name} <auftrag>`));
      continue;
    }
    const job = tui.task(agent.name, task.slice(0, 40));
    try {
      const { result } = await runSubAgent(adapter, agent, task);
      console.log(result);
    } catch (err) {
      console.log(red(`${agent.name} failed: ${err instanceof Error ? err.message : err}`));
    } finally {
      job.done();
    }
    continue;
  }
  if (input === "/research" || input.startsWith("/research ")) {
    const topic = input.slice(9).trim() || process.env.RESEARCH_TASK || "Summarize the current state of spaced repetition algorithms.";
    const researcher = agents.find((a) => a.name === "researcher");
    if (!researcher) {
      console.log(dim("no researcher agent found"));
    } else {
      const job = tui.task("researcher", "recherchiert");
      try {
        const { result } = await runSubAgent(adapter, researcher, topic);
        console.log(result);
      } finally {
        job.done();
      }
    }
    continue;
  }
  if (input.startsWith("/mkcards")) {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no deck location"));
      continue;
    }
    const topic = input.slice(8).trim() || "the last session's material";
    const writer = agents.find((a) => a.name === "card-writer");
    if (!writer) {
      console.log(red("card-writer agent fehlt (agents/card-writer.md)"));
      continue;
    }
    const job = tui.task("card-writer", topic.slice(0, 40));
    let result: string;
    try {
      ({ result } = await runSubAgent(adapter, writer, topic));
    } catch (err) {
      console.log(red(`card-writer failed: ${err instanceof Error ? err.message : err}`));
      continue;
    } finally {
      job.done();
    }
    try {
      const parsed = JSON.parse(result.slice(result.indexOf("["), result.lastIndexOf("]") + 1)) as { question: string; answer: string; concept?: string }[];
      const deck = await loadDeck();
      for (const c of parsed) deck.push(newCard(`${Date.now()}-${deck.length}`, c.question, c.answer, c.concept));
      await saveDeck(deck);
      console.log(green(`added ${parsed.length} cards (deck: ${deck.length})`));
    } catch {
      console.log(red("card-writer returned invalid JSON:\n" + result.slice(0, 400)));
    }
    continue;
  }
  if (input.startsWith("/strat")) {
    // RSI level 3: query/log which explanation strategy works per concept
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no strategies.json location"));
      continue;
    }
    // ponytail: concepts have spaces ("quadratische Ergaenzung"), so the concept is
    // whatever is left once the trailing fixed-arity arguments are taken off.
    if (input.startsWith("/stratlog")) {
      const m = /^\/stratlog\s+(.+)\s+(\S+)\s+(yes|no)$/.exec(input);
      if (!m) {
        console.log(red("usage: /stratlog <concept> <strategy> <yes|no>"));
        console.log(dim(`strategies: ${STRATEGY_NAMES.join(", ")}`));
      } else {
        await recordOutcome(vault, m[1].trim(), m[2], m[3] === "yes");
        console.log(green(`recorded: ${m[2]} on "${m[1].trim()}" -> ${m[3]}`));
      }
    } else {
      const concept = input.slice(6).trim();
      if (!concept) {
        console.log(red("usage: /strat <concept> | /stratlog <concept> <strategy> <yes|no>"));
        console.log(dim(`strategies: ${STRATEGY_NAMES.join(", ")}`));
      } else {
        const store = await loadStrategies(vault);
        const hint = strategyRotationHint(store[concept], concept);
        console.log(hint ?? dim(`no data for "${concept}" yet - record outcomes with /stratlog`));
      }
    }
    continue;
  }
  if (input === "/retrospect") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no proposals directory"));
      continue;
    }
    const agent = agents.find((a) => a.name === "retrospect");
    if (!agent) {
      console.log(red("no retrospect agent found"));
      continue;
    }
    console.log(cyan("minerva > analyzing session history..."));
    const [logs, inventory] = await Promise.all([
      readSessionLogs(vault),
      loadCurrentPrompts(["./skills"], "./agents"),
    ]);
    if (!logs.length) {
      console.log(dim("no session logs yet - nothing to analyze"));
      continue;
    }
    const { result } = await runSubAgent(adapter, agent, buildRetrospectPrompt(logs, inventory));
    try {
      const p = await writeProposal(vault, `retrospect-${new Date().toISOString().slice(0, 10)}`, result);
      console.log(green(`proposal written: ${p}`));
    } catch (e) {
      console.log(red(`proposal failed: ${e instanceof Error ? e.message : e}`));
    }
    continue;
  }
  if (input === "/examstats") {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no exams.jsonl location"));
      continue;
    }
    const weak = await topicWeaknesses(vault);
    if (!weak.length) console.log(dim("no exam data"));
    else console.table(weak.map((w) => ({ topic: w.topic, correct: Math.round(w.rate * 100) + "%" })));
    // ponytail: re-inject exam context into the system prompt for subsequent turns
    system = rebuildSystem();
    const ctx = await examSystemContext(vault);
    if (ctx) system += "\n\n" + ctx;
    continue;
  }
  if (input.startsWith("/logexam")) {
    if (!vault) {
      console.log(red("MINERVA_VAULT not set - no exams.jsonl location"));
      continue;
    }
    // ponytail: grading stays conversational, this just records the result
    const m = /^\/logexam\s+(.+?)\s+(\d+)\s*\/\s*(\d+)$/.exec(input);
    if (!m || +m[3] < 1 || +m[2] > +m[3]) {
      console.log(red("usage: /logexam <topic> <correct>/<total>"));
    } else {
      const topic = m[1].trim();
      await recordExamResult(vault, { topic, correct: +m[2], total: +m[3], date: new Date().toISOString() });
      // an exam result is hard evidence - the learner model wants exactly this
      await updateMastery(vault, "exam", topic, { mastery: +m[2] / +m[3], confidence: 0.8 }, `exam ${m[2]}/${m[3]}`).catch(() => {});
      console.log(green(`logged ${m[2]}/${m[3]} for ${topic}`));
    }
    continue;
  }
  process.stdout.write(cyan("minerva > "));
  let reply = "";
  try {
    for await (const ev of runTurn(adapter, session, history, input, tools, { system, model: currentModel })) {
      if (ev.type === "text_delta") {
        reply += ev.text;
        process.stdout.write(ev.text);
      }
      else if (ev.type === "tool_start") console.log(dim(`\n[tool] ${ev.call.name}(${ev.call.args.slice(0, 80)})`));
      else {
        history.push(...ev.newMessages);
        process.stdout.write("\n");
        if (ev.usage) {
          tui.setStatus({ used: ev.usage.inputTokens + ev.usage.outputTokens });
          console.log(dim(`(${ev.usage.inputTokens} in / ${ev.usage.outputTokens} out)`));
        }
      }
    }
  } catch (err) {
    // recovery ladder: an API error must not kill the session
    // (history stays consistent - only completed messages were pushed)
    console.log(red(`\n[error] ${err instanceof Error ? err.message : err}`));
  }
  // Feeds /retrospect. Best effort: a failing log must never break the session.
  if (vault && reply) {
    const skillTag = activeSkill ? `[${activeSkill}] ` : "";
    await recordSessionLog(vault, `${skillTag}${input.slice(0, 200)} -> ${reply.slice(0, 300)}`).catch(() => {});
  }
}
tui.close();
