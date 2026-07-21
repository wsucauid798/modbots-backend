export interface DailyActivityWindow {
  startHourUtc: number;
  endHourUtc: number;
}

export type ActivityLevel = "high" | "mid" | "low";

const minutesSinceUtcMidnight = (date: Date): number =>
  date.getUTCHours() * 60 + date.getUTCMinutes();

const minutesInDay = 24 * 60;
const midActivityShoulderMinutes = 3 * 60;

const isInUtcWindow = (
  window: DailyActivityWindow,
  minute: number,
): boolean => {
  const start = window.startHourUtc * 60;
  const end = window.endHourUtc * 60;

  if (start === end) {
    return true;
  }

  if (start < end) {
    return minute >= start && minute < end;
  }

  return minute >= start || minute < end;
};

const cyclicDistanceMinutes = (from: number, to: number): number =>
  Math.min(
    Math.abs(from - to),
    minutesInDay - Math.abs(from - to),
  );

export const activityLevelAtUtc = (
  window: DailyActivityWindow,
  date: Date,
): ActivityLevel => {
  const current = minutesSinceUtcMidnight(date);

  if (isInUtcWindow(window, current)) {
    return "high";
  }

  const start = window.startHourUtc * 60;
  const end = window.endHourUtc * 60;

  if (
    cyclicDistanceMinutes(current, start) <= midActivityShoulderMinutes ||
    cyclicDistanceMinutes(current, end) <= midActivityShoulderMinutes
  ) {
    return "mid";
  }

  return "low";
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
    return [4_000, 8_000];
  }

  if (level === "mid") {
    return [6_000, 12_000];
  }

  return [10_000, 18_000];
};
