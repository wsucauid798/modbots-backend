export type AuthMode = "optional" | "required";

export interface AppConfig {
  server: {
    host: string;
    port: number;
  };
  upps: {
    publicUrl: string;
  };
  auth: {
    mode: AuthMode;
    sessionTtlDays: number;
    // The account surface's base URL, used to validate its access tokens
    // during the browser sign-in exchange.
    accountUrl: string;
  };
  database: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  };
  redisUrl: string;
  natsUrl: string;
  objectStorage: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
  moderation: {
    minimumConfidence: number;
    allowedActions: string[];
  };
}

const required = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback?: string,
): string => {
  const value = environment[name] ?? fallback;

  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};

const port = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number => {
  const rawValue = required(environment, name, fallback);
  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  return value;
};

const url = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string => {
  const value = required(environment, name, fallback);

  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
};

const authMode = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): AuthMode => {
  const value = required(environment, name, fallback);

  if (value !== "optional" && value !== "required") {
    throw new Error(`${name} must be 'optional' or 'required'`);
  }

  return value;
};

const days = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number => {
  const value = Number(required(environment, name, fallback));

  if (!Number.isInteger(value) || value < 1 || value > 3650) {
    throw new Error(`${name} must be an integer between 1 and 3650`);
  }

  return value;
};

const confidence = (
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): number => {
  const value = Number(required(environment, name, fallback));

  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }

  return value;
};

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig => ({
  server: {
    host: required(environment, "HOST", "0.0.0.0"),
    port: port(environment, "PORT", "3001"),
  },
  upps: {
    publicUrl: url(
      environment,
      "UPPS_PUBLIC_URL",
      "http://localhost:3010",
    ),
  },
  auth: {
    mode: authMode(environment, "AUTH_MODE", "optional"),
    sessionTtlDays: days(environment, "SESSION_TTL_DAYS", "30"),
    accountUrl: url(environment, "ACCOUNT_URL", "http://localhost:3003"),
  },
  database: {
    host: required(environment, "POSTGRES_HOST", "localhost"),
    port: port(environment, "POSTGRES_PORT", "5432"),
    database: required(environment, "POSTGRES_DB", "modbots"),
    user: required(environment, "POSTGRES_USER", "modbots"),
    password: required(environment, "POSTGRES_PASSWORD", "modbots"),
  },
  redisUrl: url(environment, "REDIS_URL", "redis://localhost:6379"),
  natsUrl: url(environment, "NATS_URL", "nats://localhost:4222"),
  objectStorage: {
    endpoint: url(environment, "S3_ENDPOINT", "http://localhost:9000"),
    bucket: required(environment, "S3_BUCKET", "modbots"),
    accessKey: required(environment, "S3_ACCESS_KEY", "minioadmin"),
    secretKey: required(environment, "S3_SECRET_KEY", "minioadmin"),
  },
  moderation: {
    minimumConfidence: confidence(
      environment,
      "MODERATION_MIN_CONFIDENCE",
      "0.9",
    ),
    allowedActions: required(
      environment,
      "MODERATION_ALLOWED_ACTIONS",
      "delete_message,mute_actor,unmute_actor,remove_actor",
    )
      .split(",")
      .map((action) => action.trim())
      .filter((action) => action !== ""),
  },
});
