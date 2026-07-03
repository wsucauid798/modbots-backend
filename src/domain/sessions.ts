import { createHash, randomBytes } from "node:crypto";

// Session tokens are opaque: the raw token is returned to the client exactly
// once at issuance, and only its sha256 hash is ever stored or compared.
export const generateSessionToken = (): string =>
  randomBytes(32).toString("hex");

export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export const sessionExpiresAt = (
  ttlDays: number,
  now: Date = new Date(),
): Date => new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);

// Extract the token from an 'Authorization: Bearer <token>' header value.
// A missing header or a non-bearer scheme means the request is tokenless.
export const bearerToken = (
  authorization: string | undefined,
): string | null => {
  if (authorization === undefined) {
    return null;
  }

  const match = /^Bearer +(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
};
