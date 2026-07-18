import assert from "node:assert/strict";
import { test } from "node:test";

import {
  autonomousDelayRange,
  isActiveAtUtc,
  maximumAutonomousSilenceMs,
} from "./activity.js";
import { personas } from "./personas.js";

const atUtc = (hour: number, minute = 0): Date =>
  new Date(Date.UTC(2026, 6, 18, hour, minute));

test("uses start-inclusive and end-exclusive UTC activity windows", () => {
  const window = { startHourUtc: 4, endHourUtc: 14 };

  assert.equal(isActiveAtUtc(window, atUtc(4)), true);
  assert.equal(isActiveAtUtc(window, atUtc(13, 59)), true);
  assert.equal(isActiveAtUtc(window, atUtc(14)), false);
  assert.equal(isActiveAtUtc(window, atUtc(3, 59)), false);
});

test("supports activity windows that cross UTC midnight", () => {
  const window = { startHourUtc: 20, endHourUtc: 6 };

  assert.equal(isActiveAtUtc(window, atUtc(23)), true);
  assert.equal(isActiveAtUtc(window, atUtc(2)), true);
  assert.equal(isActiveAtUtc(window, atUtc(6)), false);
  assert.equal(isActiveAtUtc(window, atUtc(12)), false);
});

test("keeps at least one resident active throughout the UTC day", () => {
  for (let hour = 0; hour < 24; hour += 1) {
    const active = personas.filter((persona) =>
      isActiveAtUtc(persona.activity, atUtc(hour)),
    );

    assert.ok(active.length > 0, `No resident is active at ${hour}:00 UTC`);
  }
});

test("increases autonomous chat frequency when activity overlaps", () => {
  assert.deepEqual(autonomousDelayRange(1), [18_000, 40_000]);
  assert.deepEqual(autonomousDelayRange(2), [12_000, 28_000]);
  assert.deepEqual(autonomousDelayRange(3), [8_000, 20_000]);
  assert.equal(maximumAutonomousSilenceMs(1), 150_000);
  assert.equal(maximumAutonomousSilenceMs(2), 75_000);
  assert.equal(maximumAutonomousSilenceMs(3), 45_000);
});
