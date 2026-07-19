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

export const autonomousDelayRange = (
  preferredResidents: number,
): readonly [minimumMs: number, maximumMs: number] => {
  if (preferredResidents >= 3) {
    return [20_000, 45_000];
  }

  if (preferredResidents === 2) {
    return [30_000, 60_000];
  }

  if (preferredResidents === 1) {
    return [45_000, 90_000];
  }

  return [120_000, 240_000];
};

export const maximumAutonomousSilenceMs = (
  preferredResidents: number,
): number => {
  if (preferredResidents >= 3) {
    return 120_000;
  }

  if (preferredResidents === 2) {
    return 180_000;
  }

  if (preferredResidents === 1) {
    return 240_000;
  }

  return 360_000;
};
