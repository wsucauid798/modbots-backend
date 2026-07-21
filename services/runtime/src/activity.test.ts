import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityLevelAtUtc,
  autonomousDelayRange,
  roomActivityLevelAtUtc,
} from "./activity.js";

const atUtc = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, 18, hour, minute));

test("uses start-inclusive and end-exclusive high activity windows", () => {
  const window = { startHourUtc: 4, endHourUtc: 14 };

  assert.equal(activityLevelAtUtc(window, atUtc(4)), "high");
  assert.equal(activityLevelAtUtc(window, atUtc(13, 59)), "high");
  assert.equal(activityLevelAtUtc(window, atUtc(14)), "mid");
  assert.equal(activityLevelAtUtc(window, atUtc(3, 59)), "mid");
});

test("supports activity windows that cross UTC midnight", () => {
  const window = { startHourUtc: 20, endHourUtc: 6 };

  assert.equal(activityLevelAtUtc(window, atUtc(23)), "high");
  assert.equal(activityLevelAtUtc(window, atUtc(2)), "high");
  assert.equal(activityLevelAtUtc(window, atUtc(6)), "mid");
  assert.equal(activityLevelAtUtc(window, atUtc(12)), "low");
});

test("treats off-peak time as low activity instead of unavailable", () => {
  const window = { startHourUtc: 4, endHourUtc: 14 };

  assert.equal(activityLevelAtUtc(window, atUtc(22)), "low");
});

test("uses UTC for the room-wide activity rhythm", () => {
  assert.equal(roomActivityLevelAtUtc(atUtc(0)), "low");
  assert.equal(roomActivityLevelAtUtc(atUtc(5, 59)), "low");
  assert.equal(roomActivityLevelAtUtc(atUtc(6)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(7, 59)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(8)), "high");
  assert.equal(roomActivityLevelAtUtc(atUtc(17, 59)), "high");
  assert.equal(roomActivityLevelAtUtc(atUtc(18)), "mid");
  assert.equal(roomActivityLevelAtUtc(atUtc(23, 59)), "mid");
});

test("keeps autonomous chat active at every activity level", () => {
  assert.deepEqual(autonomousDelayRange("high"), [2_000, 4_000]);
  assert.deepEqual(autonomousDelayRange("mid"), [3_000, 6_000]);
  assert.deepEqual(autonomousDelayRange("low"), [4_000, 8_000]);
});
