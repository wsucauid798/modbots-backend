import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { registerCrawlerPolicy } from "./crawler-policy.js";

describe("crawler policy", () => {
  it("marks every API response as non-indexable", async () => {
    const app = Fastify();
    registerCrawlerPolicy(app);
    app.get("/resource", async () => ({ status: "ok" }));

    const rootResponse = await app.inject({ method: "GET", url: "/" });
    const resourceResponse = await app.inject({
      method: "GET",
      url: "/resource",
    });

    assert.equal(rootResponse.statusCode, 200);
    assert.equal(rootResponse.json().service, "modbots-backend-api");
    assert.equal(rootResponse.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(
      resourceResponse.headers["x-robots-tag"],
      "noindex, nofollow",
    );
    await app.close();
  });

  it("allows crawlers to read the noindex response header", async () => {
    const app = Fastify();
    registerCrawlerPolicy(app);

    const response = await app.inject({
      method: "GET",
      url: "/robots.txt",
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] ?? "", /^text\/plain/);
    assert.equal(response.body, "User-agent: *\nAllow: /\n");
    assert.equal(response.headers["x-robots-tag"], "noindex, nofollow");
    await app.close();
  });
});
