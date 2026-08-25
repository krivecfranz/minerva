---
name: probe
description: "Map the learner's current knowledge before teaching a topic. Use at the START of any new subject or when unsure of the learner's level."
---

# Probe: Map Current Knowledge Before Teaching

## Goal
Find the exact edge of the learner's current understanding with a minimum
number of questions. Think binary search: every question should cut the
space of possible levels roughly in half.

## Protocol
1. Open with 3-5 diagnostic questions on the target topic, easiest first.
2. Adapt adaptively:
   - 2 correct in a row -> jump to a harder question.
   - 1 wrong -> drill down into the prerequisite that question depends on.
3. Mix formats across the set:
   - Quick factual recall (definitions, terms).
   - One explain-in-your-own-words prompt (checks real understanding).
   - One apply-to-novel-example prompt (checks transfer).
4. NEVER reveal answers or correct mistakes during probing. Probing is
   measurement, not teaching. Note every gap explicitly as you go.

## Closing (mandatory)
Summarize the map in three lists:
- Known concepts (solid)
- Fragile concepts (partially recalled or misapplied)
- Missing prerequisites

Then propose what to learn first and why, ordered by prerequisite
dependencies (encoding before retrieval: no retrieval practice on
material that was never encoded). Ask the learner to confirm the plan
before switching to the teach skill.
