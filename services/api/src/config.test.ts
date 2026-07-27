import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads local development defaults", () => {
    const config = loadConfig({});

    assert.equal(config.server.port, 3001);
    assert.equal(config.database.host, "localhost");
    assert.equal(config.redisUrl, "redis://localhost:6379");
    assert.equal(config.upps.publicUrl, "http://localhost:3010/");
    assert.equal(config.upps.internalUrl, "http://localhost:3010/");
    assert.equal(config.translationUrl, "http://localhost:5000/");
  });

  it("rejects an invalid server port", () => {
    assert.throws(
      () => loadConfig({ PORT: "not-a-port" }),
      /PORT must be an integer/,
    );
  });

  it("rejects an invalid dependency URL", () => {
    assert.throws(
      () => loadConfig({ NATS_URL: "not a url" }),
      /NATS_URL must be a valid URL/,
    );
  });

  it("defaults authentication to optional with a 30 day session lifetime", () => {
    const config = loadConfig({});

    assert.equal(config.auth.mode, "optional");
    assert.equal(config.auth.sessionTtlDays, 30);
  });

  it("rejects an unknown authentication mode", () => {
    assert.throws(
      () => loadConfig({ AUTH_MODE: "strict" }),
      /AUTH_MODE must be 'optional' or 'required'/,
    );
  });

  it("rejects an invalid session lifetime", () => {
    assert.throws(
      () => loadConfig({ SESSION_TTL_DAYS: "0" }),
      /SESSION_TTL_DAYS must be an integer/,
    );
  });
});
