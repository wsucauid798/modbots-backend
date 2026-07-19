import type { ActivityLevel } from "./activity.js";

export type EmptyRoomHourlyLimits = Record<ActivityLevel, number>;

export const defaultEmptyRoomHourlyLimits: EmptyRoomHourlyLimits = {
  high: 12,
  mid: 6,
  low: 2,
};

const hourMs = 60 * 60_000;
const initialRateLimitBackoffMs = 60_000;
const maximumRateLimitBackoffMs = 60 * 60_000;

export class AutonomousRequestBudget {
  private readonly attempts: number[] = [];
  private blockedUntil = 0;
  private rateLimitStrikes = 0;

  public constructor(
    private readonly limits: EmptyRoomHourlyLimits =
      defaultEmptyRoomHourlyLimits,
    private readonly random: () => number = Math.random,
  ) {}

  public tryConsume(level: ActivityLevel, now: number): boolean {
    this.prune(now);

    if (now < this.blockedUntil || this.attempts.length >= this.limits[level]) {
      return false;
    }

    this.attempts.push(now);
    return true;
  }

  public recordSuccess(): void {
    this.rateLimitStrikes = 0;
    this.blockedUntil = 0;
  }

  public recordRateLimit(now: number): number {
    this.rateLimitStrikes += 1;
    const baseDelay = Math.min(
      maximumRateLimitBackoffMs,
      initialRateLimitBackoffMs * 2 ** (this.rateLimitStrikes - 1),
    );
    const delay = Math.min(
      maximumRateLimitBackoffMs,
      baseDelay * (1 + this.random()),
    );
    this.blockedUntil = Math.max(this.blockedUntil, now + delay);
    return delay;
  }

  private prune(now: number): void {
    while (
      this.attempts.length > 0 &&
      now - (this.attempts[0] ?? now) >= hourMs
    ) {
      this.attempts.shift();
    }
  }
}
