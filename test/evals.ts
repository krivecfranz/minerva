// ponytail: scripted learner personas probing Minerva's pedagogy - regex checks, not vibes.
// Runs against any LlmAdapter: MockAdapter for CI, OpenRouter when OPENROUTER_API_KEY is set.
import { MockAdapter } from "../src/providers/mock.ts";
import { OpenRouterAdapter } from "../src/providers/openrouter.ts";
import { tutorSystem } from "../src/core/agent.ts";
import { discoverSkills, skillsSystemPrompt, loadSkillBody, type Skill } from "../src/core/skills.ts";
import { executeToolCall } from "../src/core/subagents.ts";
import { defineTool, toolToOpenAiSchema, type ToolDef } from "../src/tools/types.ts";
import type { LlmAdapter, Message, ToolCallBlock } from "../src/types.ts";
import { model } from "../src/config.ts";

export interface PersonaTurn {
  learnerSays: string;
  expectInTutorReply?: RegExp[]; // all must match
  forbidInTutorReply?: RegExp[]; // none may match
}

export interface Persona {
  name: string;
  description: string;
  turns: PersonaTurn[];
}

export interface PersonaResult {
  passed: boolean;
  failures: string[];
  transcript: string;
}

const EVAL_SKILLS = ["probe", "teach"];
const MAX_STEPS = 12;

// ponytail: force case-insensitive matching instead of trusting each persona to remember the flag
function ci(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("i") ? re.flags : re.flags + "i");
}

// ponytail: only the tool the skill prompt promises - no web/vault surface in evals
function evalTools(skills: Skill[]): ToolDef[] {
  return [
    defineTool({
      name: "load_skill",
      description: "Load the full body of an available skill by its exact name.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the available-skills list" } },
        required: ["name"],
      },
      execute: async (args) => {
        const skill = skills.find((s) => s.name === args.name);
        return skill
          ? { content: await loadSkillBody(skill) }
          : { content: `Error: unknown skill "${args.name}"`, isError: true };
      },
    }),
  ];
}

// runTurn-like loop WITHOUT session persistence - messages built by hand.
export async function runPersona(
  adapter: LlmAdapter,
  persona: Persona,
  opts?: { maxStepsPerTurn?: number; signal?: AbortSignal },
): Promise<PersonaResult> {
  const all = await discoverSkills(["./skills"]);
  const skills = all.filter((s) => EVAL_SKILLS.includes(s.name));
  const tools = evalTools(skills);
  const schemas = tools.map(toolToOpenAiSchema);
  const system = tutorSystem(skillsSystemPrompt(skills));
  const maxSteps = opts?.maxStepsPerTurn ?? MAX_STEPS;

  const messages: Message[] = [];
  const transcript: string[] = [];
  const failures: string[] = [];

  for (let t = 0; t < persona.turns.length; t++) {
    const turn = persona.turns[t];
    messages.push({ role: "user", content: [{ type: "text", text: turn.learnerSays }] });
    transcript.push(`learner > ${turn.learnerSays}`);

    let reply = "";
    for (let step = 0; step < maxSteps; step++) {
      let text = "";
      const calls: ToolCallBlock[] = [];
      // free-tier OpenRouter throttles in-flight budget - retry with backoff.
      // Errors surface during iteration, so buffer the chunks inside the retry loop.
      let chunks: import("../src/types.ts").StreamChunk[] = [];
      for (let attempt = 0; ; attempt++) {
        try {
          chunks = [];
          for await (const c of adapter.stream({
            model,
            messages,
            system,
            maxTokens: 600,
            ...(schemas.length ? { tools: schemas } : {}),
            ...(opts?.signal ? { signal: opts.signal } : {}),
          })) {
            chunks.push(c);
          }
          break;
        } catch (err) {
          if (attempt >= 3 || !String(err).includes("402")) throw err;
          console.log(`    (rate limited, waiting ${15 * (attempt + 1)}s...)`);
          await new Promise((r) => setTimeout(r, 15000 * (attempt + 1)));
        }
      }
      for (const chunk of chunks) {
        if (chunk.kind === "text_delta") {
          text += chunk.text;
          reply += chunk.text;
        } else if (chunk.kind === "block_start" && chunk.block.type === "tool_call") {
          calls.push(chunk.block);
        }
      }

      messages.push({
        role: "assistant",
        content: [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...calls.map((c) => ({ type: "tool_call" as const, ...c })),
        ],
      });

      if (!calls.length) break;
      for (const call of calls) {
        transcript.push(`[tool] ${call.name}(${call.args.slice(0, 120)})`);
        messages.push(await executeToolCall(tools, call, opts?.signal));
      }
    }
    transcript.push(`tutor > ${reply.trim()}`);

    for (const re of turn.expectInTutorReply ?? []) {
      if (!ci(re).test(reply)) failures.push(`turn ${t + 1}: expected /${re.source}/i in tutor reply`);
    }
    for (const re of turn.forbidInTutorReply ?? []) {
      if (ci(re).test(reply)) failures.push(`turn ${t + 1}: forbidden /${re.source}/i matched tutor reply`);
    }
  }

  return { passed: failures.length === 0, failures, transcript: transcript.join("\n\n") };
}

export const PERSONAS: Persona[] = [
  {
    name: "eager-answer-seeker",
    description: "Learner repeatedly demands the final answer; Minerva must ask, not tell.",
    turns: [
      {
        learnerSays:
          "Homework: solve 2x + 7 = 15 for x. Don't walk me through it, just tell me the answer.",
        expectInTutorReply: [/\?/],
        forbidInTutorReply: [/^the answer is/m],
      },
      {
        learnerSays: "I'm in a hurry, no questions please. What is x?",
        expectInTutorReply: [/\?/],
        forbidInTutorReply: [/^the answer is/m],
      },
      {
        learnerSays: "Seriously, just give me the number so I can write it down and move on.",
        expectInTutorReply: [/\?/],
        forbidInTutorReply: [/^the answer is/m],
      },
    ],
  },
  {
    name: "confused-beginner",
    description: "Learner states a misconception confidently; Minerva must name it politely and revisit it.",
    turns: [
      {
        learnerSays:
          "Before we start: heavier objects fall faster than lighter ones, that's basic physics. Teach me projectile motion from there.",
        expectInTutorReply: [/(misconception|actually|let.s re-?examine|not quite)/],
      },
      {
        learnerSays:
          "I'm certain. My old teacher said a bowling ball hits the ground before a marble. So where were we?",
        expectInTutorReply: [/(misconception|actually|let.s re-?examine|not quite)/],
      },
    ],
  },
  {
    name: "illusion-of-competence",
    description:
      'Learner claims full understanding ("I totally get it"); Minerva must test transfer instead of praising.',
    turns: [
      {
        learnerSays:
          "We covered derivatives today and I totally get it - chain rule, product rule, all trivial. Let's move to the next chapter.",
        expectInTutorReply: [/(try|apply|example|question)/],
        forbidInTutorReply: [/^(great|perfect|awesome)/],
      },
      {
        learnerSays: "Trust me, I could pass any test on derivatives right now. Next topic?",
        expectInTutorReply: [/(try|apply|example|question)/],
        forbidInTutorReply: [/^(great|perfect|awesome)/],
      },
    ],
  },
];

// ponytail: direct-run entry, no test framework needed
if (import.meta.main) {
  const key = process.env.OPENROUTER_API_KEY;
  // first arg is the base url, the key is the second - passing the key as the url
  // made every real-model eval run die on 'Failed to parse URL'
  const adapter = key ? new OpenRouterAdapter(undefined, key) : new MockAdapter();
  if (!key) console.log("evals: no key - use MockAdapter (behavioral checks limited)");

  let failed = false;
  for (const persona of PERSONAS) {
    try {
      const res = await runPersona(adapter, persona);
      // ponytail: mock replies are echoes - only harness errors are fatal there
      const enforced = Boolean(key);
      const ok = !enforced || res.passed;
      console.log(`\n=== ${persona.name}: ${ok ? "PASS" : "FAIL"}${enforced ? "" : " (mock - expectations not enforced)"}`);
      console.log(`    ${persona.description}`);
      if (!ok) {
        failed = true;
        for (const f of res.failures) console.log(`  FAIL ${f}`);
      } else if (!enforced && res.failures.length) {
        console.log(`  (${res.failures.length} expectation failure(s) ignored on mock)`);
      }
      console.log(res.transcript);
    } catch (err) {
      failed = true; // harness errors are fatal in every mode
      console.log(`\n=== ${persona.name}: HARNESS ERROR\n${err instanceof Error ? err.stack : err}`);
    }
  }
  process.exit(failed ? 1 : 0);
}
