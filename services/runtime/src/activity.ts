export interface DailyActivityWindow {
  startHourUtc: number;
  endHourUtc: number;
}

export type ActivityLevel = "high" | "mid" | "low";

const minutesSinceUtcMidnight = (date: Date): number =>
  date.getUTCHours() * 60 + date.getUTCMinutes();

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
    return [8_000, 15_000];
  }

  if (level === "mid") {
    return [15_000, 30_000];
  }

  return [30_000, 60_000];
};
