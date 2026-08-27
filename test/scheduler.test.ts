import { test } from "node:test";
import assert from "node:assert/strict";
import { newCard, sortDue, interleave, type MinervaCard } from "../src/core/scheduler.ts";

const card = (id: string, concept?: string): MinervaCard => newCard(id, `Q ${id}`, `A ${id}`, concept);
const at = (c: MinervaCard, iso: string): MinervaCard => ({ ...c, fsrs: { ...(c.fsrs as object), due: new Date(iso) } });

test("newCard keeps the concept", () => {
  assert.equal(card("1", "kettenregel").concept, "kettenregel");
  assert.equal(card("2").concept, undefined);
});

test("sortDue orders future cards by due date", () => {
  const now = new Date("2026-08-27T00:00:00Z");
  const later = at(card("spaeter"), "2026-09-04T00:00:00Z");
  const sooner = at(card("frueher"), "2026-08-29T00:00:00Z");
  assert.deepEqual(sortDue([later, sooner], now).map((c) => c.id), ["frueher", "spaeter"]);
  assert.deepEqual(sortDue([sooner, later], now).map((c) => c.id), ["frueher", "spaeter"]);
});

test("sortDue still puts the most overdue first", () => {
  const now = new Date("2026-08-27T00:00:00Z");
  const old = at(card("alt"), "2026-08-01T00:00:00Z");
  const recent = at(card("neu"), "2026-08-26T00:00:00Z");
  assert.deepEqual(sortDue([recent, old], now).map((c) => c.id), ["alt", "neu"]);
});

test("interleave mixes concepts and loses no cards", () => {
  const cards = [card("a1", "A"), card("a2", "A"), card("a3", "A"), card("b1", "B"), card("b2", "B")];
  const mixed = interleave(cards);
  assert.equal(mixed.length, cards.length);
  assert.deepEqual([...mixed].map((c) => c.id).sort(), ["a1", "a2", "a3", "b1", "b2"]);
  // 3xA and 2xB can be laid out with no repeat at all
  const repeats = mixed.filter((c, i) => i > 0 && c.concept === mixed[i - 1].concept);
  assert.deepEqual(repeats, [], "no two consecutive cards from the same concept");
});

test("interleave leaves a single-concept deck alone", () => {
  const cards = [card("a", "A"), card("b", "A")];
  assert.deepEqual(interleave(cards).map((c) => c.id), ["a", "b"]);
  assert.deepEqual(interleave([]).map((c) => c.id), []);
});
