import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bearerToken,
  generateSessionToken,
  hashSessionToken,
  sessionExpiresAt,
} from "./sessions.js";

describe("generateSessionToken", () => {
  it("produces 32 random bytes as lowercase hex", () => {
    const token = generateSessionToken();

    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, generateSessionToken());
  });
});

describe("hashSessionToken", () => {
  it("produces the lowercase hex sha256 of the raw token", () => {
    assert.equal(
      hashSessionToken("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sessionExpiresAt", () => {
  it("adds the configured lifetime in days", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    assert.equal(
      sessionExpiresAt(30, now).toISOString(),
      "2026-01-31T00:00:00.000Z",
    );
  });
});

describe("bearerToken", () => {
  it("extracts the token from a bearer authorization header", () => {
    assert.equal(bearerToken("Bearer abc123"), "abc123");
    assert.equal(bearerToken("bearer abc123"), "abc123");
  });

  it("treats missing and non-bearer headers as tokenless", () => {
    assert.equal(bearerToken(undefined), null);
    assert.equal(bearerToken("Basic dXNlcjpwYXNz"), null);
    assert.equal(bearerToken("Bearer "), null);
  });
});
