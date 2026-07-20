import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { inferenceRoutes } from "./inference.js";

describe("inference routes", () => {
  it("serves the pinned client inference manifest", async () => {
    const app = Fastify();
    await app.register(
      inferenceRoutes({
        contractVersion: 1,
        entityType: "inference_pipeline_manifest",
        manifestVersion: "test-1",
      }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/inference/manifest",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().manifestVersion, "test-1");
    assert.equal(response.headers["cache-control"], "public, max-age=300");
    await app.close();
  });
});
