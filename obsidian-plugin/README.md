# Minerva Reviews

Obsidian plugin that shows due Minerva spaced-repetition cards and the last 5 session summaries.
Read-only: it only reads `000-Meta/minerva/cards.json` and `000-Meta/minerva/sessions.jsonl` written by Minerva's CLI.

Install:
1. Copy this folder to `<your-vault>/.obsidian/plugins/minerva-reviews/`.
2. Build with esbuild:
   `esbuild main.ts --bundle --external:obsidian --format=cjs --outfile=main.js`
3. Reload Obsidian and enable "Minerva Reviews" in Community Plugins.
