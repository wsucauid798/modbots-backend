import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autonomousDelayRange,
  isOnClockAtUtc,
  millisecondsUntilNextShiftBoundary,
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
  assert.deepEqual(autonomousDelayRange("high"), [60_000, 120_000]);
  assert.deepEqual(autonomousDelayRange("mid"), [120_000, 240_000]);
  assert.deepEqual(autonomousDelayRange("low"), [300_000, 600_000]);
});

test("mod bot work shifts cover the full day without overlap", () => {
  const vera = { startHourUtc: 0, endHourUtc: 8 };
  const milo = { startHourUtc: 8, endHourUtc: 16 };
  const iris = { startHourUtc: 16, endHourUtc: 0 };

  assert.deepEqual(
    [vera, milo, iris].map((shift) => isOnClockAtUtc(atUtc(0), shift)),
    [true, false, false],
  );
  assert.deepEqual(
    [vera, milo, iris].map((shift) => isOnClockAtUtc(atUtc(8), shift)),
    [false, true, false],
  );
  assert.deepEqual(
    [vera, milo, iris].map((shift) => isOnClockAtUtc(atUtc(16), shift)),
    [false, false, true],
  );
  assert.deepEqual(
    [vera, milo, iris].map((shift) => isOnClockAtUtc(atUtc(23, 59), shift)),
    [false, false, true],
  );
});

test("finds the next mod bot shift boundary", () => {
  const shifts = [
    { startHourUtc: 0, endHourUtc: 8 },
    { startHourUtc: 8, endHourUtc: 16 },
    { startHourUtc: 16, endHourUtc: 0 },
  ];

  assert.equal(
    millisecondsUntilNextShiftBoundary(atUtc(7, 30), shifts),
    30 * 60_000,
  );
  assert.equal(
    millisecondsUntilNextShiftBoundary(atUtc(23, 59), shifts),
    60_000,
  );
});
