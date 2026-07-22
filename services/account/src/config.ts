export interface AccountConfig {
  host: string;
  port: number;
  // Public base URL of this service; the OIDC issuer identifier.
  issuer: string;
  backendUrl: string;
  redisUrl: string;
  // Secret for signing the account session cookie and OIDC cookies.
  cookieSecret: string;
  desktopRedirectUri: string;
  webRedirectUri: string;
}

export const loadConfig = (
  environment: NodeJS.ProcessEnv = process.env,
): AccountConfig => {
  const port = Number(environment.PORT ?? "3003");

  return {
    host: environment.HOST ?? "0.0.0.0",
    port: Number.isFinite(port) ? port : 3003,
    issuer: environment.ACCOUNT_ISSUER ?? "http://localhost:3003",
    backendUrl: environment.BACKEND_URL ?? "http://localhost:3001",
    redisUrl: environment.REDIS_URL ?? "redis://localhost:6379",
    cookieSecret:
      environment.COOKIE_SECRET ?? "dev-only-cookie-secret-change-me",
    desktopRedirectUri:
      environment.DESKTOP_REDIRECT_URI ?? "http://127.0.0.1:53682/callback",
    webRedirectUri:
      environment.WEB_REDIRECT_URI ?? "http://localhost:3000/login/callback",
  };
};
