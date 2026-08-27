import { test } from "node:test";
import assert from "node:assert/strict";
import { Tui, visibleWidth } from "../src/ui/tui.ts";

// ponytail: the chrome is the one place where a padding bug is invisible in review
// but shreds the layout at runtime. Every drawn line must be exactly `width` wide.

const make = () => new Tui({ cwd: "~/dev/minerva", provider: "nvidia", model: "deepseek-v4-pro" });
const priv = (t: Tui) => t as unknown as {
  width: number;
  buffer: string;
  cursor: number;
  taskBox(): string[];
  inputBox(): string[];
  statusLine(): string;
};

test("visibleWidth ignores colour codes", () => {
  assert.equal(visibleWidth("\x1b[38;2;1;2;3mabc\x1b[0m"), 3);
  assert.equal(visibleWidth("plain"), 5);
});

test("input box lines are exactly terminal width", () => {
  const tui = make();
  const p = priv(tui);
  for (const text of ["", "kurz", "x".repeat(200)]) {
    p.buffer = text;
    p.cursor = text.length;
    for (const line of p.inputBox()) {
      assert.equal(visibleWidth(line), p.width, `input box line: ${JSON.stringify(text.slice(0, 10))}`);
    }
  }
});

test("long input keeps the cursor end visible", () => {
  const tui = make();
  const p = priv(tui);
  p.buffer = "a".repeat(100) + "ENDE";
  p.cursor = p.buffer.length;
  const field = p.inputBox()[1];
  assert.ok(field.includes("ENDE"), "the tail the user is typing must stay on screen");
});

test("task box lines are exactly terminal width", () => {
  const tui = make();
  const p = priv(tui);
  assert.deepEqual(p.taskBox(), [], "no tasks, no box");
  const a = tui.task("researcher", "recherchiert");
  const b = tui.task("card-writer", "x".repeat(60));
  for (const line of p.taskBox()) assert.equal(visibleWidth(line), p.width);
  a.done();
  b.done();
  assert.deepEqual(p.taskBox(), [], "box disappears once the tasks finish");
});

test("status line fits and reports context", () => {
  const tui = make();
  const p = priv(tui);
  assert.equal(visibleWidth(p.statusLine()), p.width);
  tui.setStatus({ used: 41234 });
  assert.match(p.statusLine(), /41\.2k ctx/);
  tui.setStatus({ max: 128000 });
  assert.match(p.statusLine(), /32\.2%\/128k/);
});

test("slash suggestions filter, complete and fit the width", () => {
  const tui = make();
  const p = priv(tui) as unknown as { buffer: string; cursor: number; width: number; suggestionLines(): string[] };
  tui.setCommands([
    { name: "/skill", hint: "Lehr-Protokoll aktivieren" },
    { name: "/stratlog", hint: "x".repeat(200) },
    { name: "/strat", hint: "Erklaerstrategien" },
    { name: "/exit", hint: "beenden" },
  ]);

  p.buffer = "";
  assert.deepEqual(tui.matches(), [], "plain text gets no command list");

  p.buffer = "/s";
  assert.deepEqual(tui.matches().map((c) => c.name), ["/skill", "/stratlog", "/strat"]);

  p.buffer = "/skill";
  assert.deepEqual(tui.matches(), [], "an exact single hit stops suggesting");

  p.buffer = "/skill teach";
  assert.deepEqual(tui.matches(), [], "no suggestions once an argument is typed");

  p.buffer = "/strat";
  for (const line of p.suggestionLines()) {
    assert.ok(visibleWidth(line) <= p.width, "a suggestion must never wrap the line");
  }
});
