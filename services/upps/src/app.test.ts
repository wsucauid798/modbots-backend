import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";

const publicDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
);
const serviceToken = "test-upps-service-token";
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("UPPS", () => {
  it("serves a profile picture by its stable identifier", async () => {
    const app = buildApp({
      server: { host: "127.0.0.1", port: 3010 },
      publicDir,
      serviceToken,
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
      serviceToken,
    });

    const response = await app.inject({
      method: "GET",
      url: "/profile-pictures/unknown",
    });

    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error, "profile_picture_not_found");

    await app.close();
  });

  it("stores, serves, and removes an authenticated user profile picture", async () => {
    const temporaryPublicDir = await mkdtemp(
      path.join(os.tmpdir(), "modbots-upps-"),
    );
    temporaryDirectories.push(temporaryPublicDir);
    const app = buildApp({
      server: { host: "127.0.0.1", port: 3010 },
      publicDir: temporaryPublicDir,
      serviceToken,
    });
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
      "hex",
    );

    const upload = await app.inject({
      method: "POST",
      url: "/internal/profile-pictures",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: { data: png.toString("base64") },
    });

    assert.equal(upload.statusCode, 201);
    assert.match(upload.json().profilePictureId, /^user-/);

    const served = await app.inject({
      method: "GET",
      url: `/profile-pictures/${upload.json().profilePictureId}`,
    });

    assert.equal(served.statusCode, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.deepEqual(served.rawPayload, png);

    const removed = await app.inject({
      method: "DELETE",
      url: `/internal/profile-pictures/${upload.json().profilePictureId}`,
      headers: { authorization: `Bearer ${serviceToken}` },
    });

    assert.equal(removed.statusCode, 204);
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/profile-pictures/${upload.json().profilePictureId}`,
        })
      ).statusCode,
      404,
    );

    await app.close();
  });

  it("rejects unauthenticated and unsupported uploads", async () => {
    const temporaryPublicDir = await mkdtemp(
      path.join(os.tmpdir(), "modbots-upps-"),
    );
    temporaryDirectories.push(temporaryPublicDir);
    const app = buildApp({
      server: { host: "127.0.0.1", port: 3010 },
      publicDir: temporaryPublicDir,
      serviceToken,
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/internal/profile-pictures",
      payload: { data: Buffer.from("not an image").toString("base64") },
    });
    const unsupported = await app.inject({
      method: "POST",
      url: "/internal/profile-pictures",
      headers: { authorization: `Bearer ${serviceToken}` },
      payload: { data: Buffer.from("not an image").toString("base64") },
    });

    assert.equal(unauthorized.statusCode, 401);
    assert.equal(unsupported.statusCode, 400);

    await app.close();
  });
});
