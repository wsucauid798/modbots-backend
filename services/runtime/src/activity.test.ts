import assert from "node:assert/strict";
import { test } from "node:test";

import { autonomousDelayRange } from "./activity.js";

test("uses one steady autonomous chat cadence", () => {
  assert.deepEqual(autonomousDelayRange(), [2_000, 4_000]);
});
