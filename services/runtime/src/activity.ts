export interface DailyActivityWindow {
  startHourUtc: number;
  endHourUtc: number;
}

export const autonomousDelayRange = (): readonly [
  minimumMs: number,
  maximumMs: number,
] => [2_000, 4_000];
