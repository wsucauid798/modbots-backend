import assert from "node:assert/strict";
import test from "node:test";
import { messageCadenceFor } from "./mind.js";

test("selects varied message lengths across the cadence distribution", () => {
  assert.match(messageCadenceFor(0), /2 to 6 words/);
  assert.match(messageCadenceFor(0.3), /7 to 14 words/);
  assert.match(messageCadenceFor(0.75), /15 to 22 words/);
  assert.match(messageCadenceFor(0.95), /23 to 32 words/);
});
