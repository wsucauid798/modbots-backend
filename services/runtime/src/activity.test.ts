import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autonomousDelayRange,
  roomActivityLevelAtUtc,
} from "./activity.js";

const atUtc = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, 18, hour, minute));

test("divides the room day into low, mid, and high UTC activity", () => {
  assert.equal(roomActivityLevelAtUtc(atUtc(0)), "low");
  assert.equal(roomActivityLevelAtUtc(atUtc(5, 59)), "low");
  assert.equal(roomActivityLevelAtUtc(atUtc(6)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(7, 59)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(8)), "high");
  assert.equal(roomActivityLevelAtUtc(atUtc(17, 59)), "high");
  assert.equal(roomActivityLevelAtUtc(atUtc(18)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(23, 59)), "mid");
});

test("chats less often as room activity falls", () => {
  assert.deepEqual(autonomousDelayRange("high"), [2_000, 4_000]);
  assert.deepEqual(autonomousDelayRange("mid"), [3_000, 6_000]);
  assert.deepEqual(autonomousDelayRange("low"), [4_000, 8_000]);
});
