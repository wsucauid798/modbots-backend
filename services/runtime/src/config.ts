export interface RuntimeConfig {
  apiUrl: string;
  realtimeUrl: string;
  mlUrl: string;
  roomId: string;
  // Multiplier over all conversational delays. 1 is the normal calm pace;
  // lower is chattier. Used to speed verification without code changes.
  tempo: number;
}

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeConfig => {
  const tempo = Number(environment.CHAT_TEMPO ?? "1");

  return {
    apiUrl: environment.MODBOTS_API_URL ?? "http://localhost:3001",
    realtimeUrl: environment.MODBOTS_REALTIME_URL ?? "ws://localhost:3002",
    mlUrl: environment.ML_URL ?? "http://localhost:8000",
    roomId: environment.MODBOTS_ROOM_ID ?? "global-lobby",
    tempo: Number.isFinite(tempo) && tempo > 0 ? tempo : 1,
  };
};
