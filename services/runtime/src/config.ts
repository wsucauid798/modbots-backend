export interface RuntimeConfig {
  apiUrl: string;
  realtimeUrl: string;
  mlUrl: string;
  roomId: string;
  experienceDir: string;
  // Multiplier over all conversational delays. 1 is the normal calm pace;
  // lower is chattier. Used to speed verification without code changes.
  tempo: number;
  autonomousInferenceLimitPerHour: number;
  internetResearchLimitPerHour: number;
  internetResearchCooldownMs: number;
}

const positiveNumber = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig => {
  const tempo = positiveNumber(environment.CHAT_TEMPO, 1);
  const autonomousInferenceLimitPerHour = Math.floor(
    positiveNumber(environment.AUTONOMOUS_INFERENCE_LIMIT_PER_HOUR, 12),
  );
  const internetResearchLimitPerHour = Math.floor(
    positiveNumber(environment.INTERNET_RESEARCH_LIMIT_PER_HOUR, 4),
  );
  const internetResearchCooldownMs =
    positiveNumber(environment.INTERNET_RESEARCH_COOLDOWN_MINUTES, 360) *
    60_000;

  return {
    apiUrl: environment.MODBOTS_API_URL ?? "http://localhost:3001",
    realtimeUrl: environment.MODBOTS_REALTIME_URL ?? "ws://localhost:3002",
    mlUrl: environment.ML_URL ?? "http://localhost:8000",
    roomId: environment.MODBOTS_ROOM_ID ?? "global-lobby",
    experienceDir:
      environment.RUNTIME_EXPERIENCE_DIR ?? ".runtime-experience",
    tempo,
    autonomousInferenceLimitPerHour,
    internetResearchLimitPerHour,
    internetResearchCooldownMs,
  };
};
