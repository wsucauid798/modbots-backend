import assert from "node:assert/strict";
import test from "node:test";
import { messageCadenceFor } from "./mind.js";

test("selects varied message lengths across the cadence distribution", () => {
  assert.match(messageCadenceFor(0), /2 to 6 words/);
  assert.match(messageCadenceFor(0.2), /7 to 12 words/);
  assert.match(messageCadenceFor(0.5), /13 to 22 words/);
  assert.match(messageCadenceFor(0.8), /23 to 38 words/);
});
