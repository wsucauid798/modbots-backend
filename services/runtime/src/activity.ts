export interface DailyActivityWindow {
  startHourUtc: number;
  endHourUtc: number;
}

const minutesSinceUtcMidnight = (date: Date): number =>
  date.getUTCHours() * 60 + date.getUTCMinutes();

export const isActiveAtUtc = (
  window: DailyActivityWindow,
  date: Date,
): boolean => {
  const current = minutesSinceUtcMidnight(date);
  const start = window.startHourUtc * 60;
  const end = window.endHourUtc * 60;

  if (start === end) {
    return true;
  }

  if (start < end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
};

export const autonomousDelayRange = (
  activeResidents: number,
): readonly [minimumMs: number, maximumMs: number] => {
  if (activeResidents >= 3) {
    return [8_000, 20_000];
  }

  if (activeResidents === 2) {
    return [12_000, 28_000];
  }

  return [18_000, 40_000];
};

export const maximumAutonomousSilenceMs = (
  activeResidents: number,
): number => {
  if (activeResidents >= 3) {
    return 45_000;
  }

  if (activeResidents === 2) {
    return 75_000;
  }

  return 150_000;
};
