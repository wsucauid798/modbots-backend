import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);

describe("UPPS", () => {
  it("serves a profile picture by its stable identifier", async () => {
    const app = buildApp({
      server: { host: "127.0.0.1", port: 3010 },
      publicDir,
    });

    const response = await app.inject({
      method: "GET",
      url: "/profile-pictures/resident-arwen",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/webp");
    assert.ok(response.rawPayload.length > 0);

    await app.close();
  });

  it("reports an unknown profile-picture identifier", async () => {
    const app = buildApp({
      server: { host: "127.0.0.1", port: 3010 },
      publicDir,
    });

    const response = await app.inject({
      method: "GET",
      url: "/profile-pictures/unknown",
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "profile_picture_not_found");

    await app.close();
  });
});
