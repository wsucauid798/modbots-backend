import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("loads local development defaults", () => {
    const config = loadConfig({});

    assert.equal(config.server.port, 3001);
    assert.equal(config.database.host, "localhost");
    assert.equal(config.redisUrl, "redis://localhost:6379");
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
});
