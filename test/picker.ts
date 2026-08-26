// ponytail: one runnable check for the fuzzy matcher behind /model.
import { fuzzyScore } from "../src/ui/picker.ts";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
}

assert(fuzzyScore("", "anything") === 0, "empty needle matches everything with score 0");
assert(fuzzyScore("qwen", "qwen-obliterated:latest") === 0, "contiguous prefix match scores 0");
assert(fuzzyScore("lm", "google/gemma-4-e4b (lmstudio)") !== null, "subsequence across category suffix matches");
assert(fuzzyScore("xyz", "qwen-obliterated") === null, "non-subsequence does not match");
assert((fuzzyScore("g4o", "gpt-4o") ?? -1) > (fuzzyScore("gpt", "gpt-4o") ?? -1), "gappy match scores worse than a contiguous one");

console.log("\nPICKER OK");
