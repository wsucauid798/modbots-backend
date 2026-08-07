import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { VisualExpressionService } from "../visual-expressions.js";
import { visualExpressionRoutes } from "./visual-expressions.js";

const authorizedActors: string[] = [];
const auth: WriteAuthorizer = {
  authorizeActor: async (_authorization, actorId) => {
    authorizedActors.push(actorId);
  },
};

const actors: ActorRepository = {
  getById: async (actorId) =>
    actorId === "human-1"
      ? {
          id: actorId,
          handle: "william",
          displayName: "William",
          discriminator: "2519",
          registered: true,
          display: "William#2519",
          profilePictureId: null,
          profilePictureUrl: null,
          bio: null,
          pronouns: null,
          location: null,
          links: [],
          statusMode: null,
          statusText: null,
          type: "human",
          policyVersionAccepted: "1",
          policyAcceptedAt: "2026-08-08T00:00:00.000Z",
          retiredAt: null,
          createdAt: "2026-08-08T00:00:00.000Z",
        }
      : null,
  getByHandle: async () => null,
  recordPolicyAcceptance: async () => null,
};

const visualRequests: unknown[] = [];
const visuals: VisualExpressionService = {
  renderMeme: async (request) => {
    visualRequests.push(request);
    return {
      data: "PHN2Zy8+",
      mediaType: "image/svg+xml",
      width: 960,
      height: 720,
    };
  },
  renderReactionGif: async (request) => {
    visualRequests.push(request);
    return {
      data: "R0lGODlh",
      mediaType: "image/gif",
      width: 720,
      height: 480,
    };
  },
};

describe("visual expression routes", () => {
  it("renders a human-authored meme without accepting a forged author", async () => {
    authorizedActors.length = 0;
    visualRequests.length = 0;
    const app = Fastify();
    await app.register(visualExpressionRoutes(actors, auth, visuals));

    const response = await app.inject({
      method: "POST",
      url: "/api/expressions/memes",
      headers: { authorization: "Bearer session-token" },
      payload: {
        actorId: "human-1",
        author: "Someone else",
        template: "contrast",
        topText: "The plan",
        bottomText: "What happened",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().caption, "Meme by William#2519");
    assert.equal(
      response.json().altText,
      "Meme: The plan. What happened.",
    );
    assert.deepEqual(authorizedActors, ["human-1"]);
    assert.deepEqual(visualRequests, [
      {
        template: "contrast",
        topText: "The plan",
        bottomText: "What happened",
        author: "William#2519",
      },
    ]);
    await app.close();
  });

  it("renders a selected animated reaction GIF", async () => {
    visualRequests.length = 0;
    const app = Fastify();
    await app.register(visualExpressionRoutes(actors, auth, visuals));

    const response = await app.inject({
      method: "POST",
      url: "/api/expressions/reaction-gifs",
      payload: {
        actorId: "human-1",
        template: "facepalm",
        text: "When it compiles on the second try",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().mediaType, "image/gif");
    assert.equal(
      response.json().altText,
      "Animated facepalm reaction: When it compiles on the second try.",
    );
    assert.deepEqual(visualRequests, [
      {
        template: "facepalm",
        text: "When it compiles on the second try",
        author: "William#2519",
      },
    ]);
    await app.close();
  });

  it("rejects unknown templates before rendering", async () => {
    visualRequests.length = 0;
    const app = Fastify();
    await app.register(visualExpressionRoutes(actors, auth, visuals));

    const response = await app.inject({
      method: "POST",
      url: "/api/expressions/memes",
      payload: {
        actorId: "human-1",
        template: "unknown",
        topText: "Top",
        bottomText: "Bottom",
      },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(visualRequests, []);
    await app.close();
  });
});
