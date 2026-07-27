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
    return [2_000, 4_000];
  }

  if (level === "mid") {
    return [3_000, 6_000];
  }

  return [4_000, 8_000];
};
