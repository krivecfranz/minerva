# Minerva

A personal AI tutor as an agent harness. One teacher, one student: Minerva maps
what you already know, plans and verifies the material with subagents, teaches
Socratically one step at a time, and schedules spaced-repetition reviews - all
grounded in learning science (retrieval practice, desirable difficulties,
Dehaene's four pillars, encoding before repetition).

Core design rule taken from the research corpus:

> Maximize struggle in the material, minimize struggle in logistics.
> The tutor handles planning, verification and source work; the learner does
> the thinking.

## Features

- **Agent loop** with tool execution, crash-resumable JSONL sessions
  (user message hits disk before the first API call)
- **Provider seam** - swap models via config, not code:
  OpenRouter (any cloud model), Ollama (local), or a keyless mock for tests
- **Tools**: web search + fetch, YouTube transcripts via yt-dlp,
  Obsidian vault read/write (path-whitelisted, symlink-hardened,
  human notes are never modified)
- **Subagents** with isolated context: `researcher`, `fact-checker`,
  `scout`, `card-writer`, `grader`
- **Pedagogy skills**: `probe` (binary-search diagnostics),
  `teach` (Socratic, one step per turn), `review` (interleaved retrieval),
  `exam` (timed simulation with strict grading)
- **FSRS spaced repetition** built in (`ts-fsrs`): `/mkcards` generates cards
  from material, `/review` runs interleaved review sessions
- **Learner model** persisted inside your Obsidian vault
  (`000-Meta/minerva/`), mastery updates require evidence
- **Eval suite**: scripted learner personas check that the tutor actually
  follows its pedagogy rules against real models

## Quick start

Requires Node 26+ (uses native TypeScript type stripping). No build step.

```bash
npm install

# cloud models
export OPENROUTER_API_KEY=sk-or-...
# or local models
export MINERVA_PROVIDER=ollama        # needs Ollama on :11434

# your Obsidian vault (optional but recommended)
export MINERVA_VAULT=/path/to/your/vault
export MINERVA_VAULT_WRITE_DIRS="000-Meta/minerva,100-Concepts,200-Sources,900-Raw"

npm start
```

Session commands:

| Command | Purpose |
|---|---|
| `/skill probe` | map current knowledge before teaching |
| `/skill teach` | Socratic teaching mode |
| `/skill review` | consolidation protocol |
| `/skill exam` | timed exam simulation |
| `/research` | run the researcher subagent |
| `/mkcards <topic>` | generate FSRS cards from material |
| `/review` | grade due cards (1=again 2=hard 3=good 4=easy) |
| `/exit` | leave |

## Obsidian integration

Minerva reads and writes plain Markdown inside your vault:

```
000-Meta/minerva/   learner model, card deck, session logs (machine state)
100-Concepts/       atomic concept notes (created with origin: minerva frontmatter)
200-Sources/        source notes referenced by citations
```

Everything Minerva writes is marked with `origin: minerva` frontmatter.
Notes without that marker are treated as human notes and can never be
overwritten or appended to. Optional dashboard plugin in
[`obsidian-plugin/`](obsidian-plugin/) shows due reviews inside Obsidian.

## Tests

```bash
node --experimental-strip-types test/smoke.ts   # end-to-end loop test (keyless)
node --experimental-strip-types test/evals.ts   # behavioral evals (needs API key)
```

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | - | enables cloud models |
| `MINERVA_PROVIDER` | `auto` | `openrouter` \| `ollama` \| `mock` \| `auto` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | local Ollama endpoint |
| `MINERVA_MODEL` | `anthropic/claude-sonnet-4.5` | model id for the tutor |
| `MINERVA_MAX_TOKENS` | `1200` | per-request output budget |
| `MINERVA_VAULT` | - | path to your Obsidian vault |
| `MINERVA_VAULT_WRITE_DIRS` | `000-Meta/minerva,100-Concepts,...` | write whitelist |

## Status

Early prototype. M0-M3 milestones complete, verified through independent
review passes plus scripted smoke/eval suites. See `PLAN.md` history in the
project docs for the roadmap (A/B explanation strategies, exam analytics and
an extended Obsidian plugin are next).

## License

MIT
