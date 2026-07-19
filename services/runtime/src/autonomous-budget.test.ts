import assert from "node:assert/strict";
import test from "node:test";

import { AutonomousRequestBudget } from "./autonomous-budget.js";

test("enforces rolling high, mid, and low empty-room request limits", () => {
  const high = new AutonomousRequestBudget(undefined, () => 0);

  for (let request = 0; request < 12; request += 1) {
    assert.equal(high.tryConsume("high", request), true);
  }

  assert.equal(high.tryConsume("high", 12), false);
  assert.equal(high.tryConsume("high", 3_600_000), true);

  const mid = new AutonomousRequestBudget(undefined, () => 0);
  const low = new AutonomousRequestBudget(undefined, () => 0);

  assert.deepEqual(
    Array.from({ length: 7 }, (_, request) =>
      mid.tryConsume("mid", request),
    ),
    [true, true, true, true, true, true, false],
  );
  assert.deepEqual(
    Array.from({ length: 3 }, (_, request) =>
      low.tryConsume("low", request),
    ),
    [true, true, false],
  );
});

test("backs off empty-room requests after a rate limit", () => {
  const budget = new AutonomousRequestBudget(undefined, () => 0);

  assert.equal(budget.recordRateLimit(1_000), 60_000);
  assert.equal(budget.tryConsume("high", 60_999), false);
  assert.equal(budget.tryConsume("high", 61_000), true);

  budget.recordSuccess();
  assert.equal(budget.tryConsume("high", 61_001), true);
});
