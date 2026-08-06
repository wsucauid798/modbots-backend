export interface DailyWorkShift {
  startHourUtc: number;
  endHourUtc: number;
}

export type ActivityLevel = "high" | "mid" | "low";

const minutesSinceUtcMidnight = (date: Date): number =>
  date.getUTCHours() * 60 + date.getUTCMinutes();

export const isOnClockAtUtc = (
  date: Date,
  shift: DailyWorkShift,
): boolean => {
  const current = minutesSinceUtcMidnight(date);
  const start = shift.startHourUtc * 60;
  const end = shift.endHourUtc * 60;

  if (start < end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
};

export const millisecondsUntilNextShiftBoundary = (
  date: Date,
  shifts: DailyWorkShift[],
): number => {
  const dayMs = 24 * 60 * 60_000;
  const current =
    date.getUTCHours() * 60 * 60_000 +
    date.getUTCMinutes() * 60_000 +
    date.getUTCSeconds() * 1_000 +
    date.getUTCMilliseconds();
  const boundaries = shifts.flatMap((shift) => [
    shift.startHourUtc * 60 * 60_000,
    shift.endHourUtc * 60 * 60_000,
  ]);

  return Math.min(
    ...boundaries.map((boundary) => {
      const remaining = (boundary - current + dayMs) % dayMs;
      return remaining === 0 ? dayMs : remaining;
    }),
  );
};

export const roomActivityLevelAtUtc = (date: Date): ActivityLevel => {
  const current = minutesSinceUtcMidnight(date);
  const lowEnds = 6 * 60;
  const highStarts = 8 * 60;
  const highEnds = 18 * 60;

  if (current < lowEnds) {
    return "low";
  }

  if (current >= highStarts && current < highEnds) {
    return "high";
  }

  return "mid";
};

export const autonomousDelayRange = (
  level: ActivityLevel,
): readonly [minimumMs: number, maximumMs: number] => {
  if (level === "high") {
    return [60_000, 120_000];
  }

  if (level === "mid") {
    return [120_000, 240_000];
  }

  return [300_000, 600_000];
};
