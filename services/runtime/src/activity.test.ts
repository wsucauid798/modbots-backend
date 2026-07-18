import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityLevelAtUtc,
  autonomousDelayRange,
  maximumAutonomousSilenceMs,
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

test("increases autonomous chat frequency when activity overlaps", () => {
  assert.deepEqual(autonomousDelayRange(0), [60_000, 180_000]);
  assert.deepEqual(autonomousDelayRange(1), [18_000, 40_000]);
  assert.deepEqual(autonomousDelayRange(2), [12_000, 28_000]);
  assert.deepEqual(autonomousDelayRange(3), [8_000, 20_000]);
  assert.equal(maximumAutonomousSilenceMs(0), 240_000);
  assert.equal(maximumAutonomousSilenceMs(1), 150_000);
  assert.equal(maximumAutonomousSilenceMs(2), 75_000);
  assert.equal(maximumAutonomousSilenceMs(3), 45_000);
});
