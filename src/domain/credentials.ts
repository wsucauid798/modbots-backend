import argon2 from "argon2";

// Passwords are hashed with argon2id and only the hash is ever stored.
// Verification failures and unknown usernames must cost the same, so the
// unknown-username path verifies against a fallback hash instead of
// returning early.
export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password, { type: argon2.argon2id });

export const verifyPassword = (
  hash: string,
  password: string,
): Promise<boolean> => argon2.verify(hash, password).catch(() => false);

let fallbackHash: Promise<string> | null = null;

export const verifyAgainstFallback = async (
  password: string,
): Promise<false> => {
  fallbackHash ??= hashPassword("fallback-timing-equalizer");
  await verifyPassword(await fallbackHash, password);
  return false;
};
