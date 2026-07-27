import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import type { TranslationService } from "../translation.js";
import { translationRoutes } from "./translations.js";

const authorizedActors: string[] = [];
const auth: WriteAuthorizer = {
  authorizeActor: async (_authorization, actorId) => {
    authorizedActors.push(actorId);
  },
};

const translations: TranslationService = {
  translate: async (request) =>
    request.texts.map((text) =>
      request.targetLanguage === "zh-CN" ? `中文：${text}` : `English: ${text}`,
    ),
};

describe("translation routes", () => {
  it("translates an authenticated batch into the selected chat language", async () => {
    authorizedActors.length = 0;
    const app = Fastify();
    await app.register(translationRoutes(translations, auth));

    const response = await app.inject({
      method: "POST",
      url: "/api/translations",
      headers: { authorization: "Bearer session-token" },
      payload: {
        actorId: "human-1",
        texts: ["Hello", "How are you?"],
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().translations, [
      "中文：Hello",
      "中文：How are you?",
    ]);
    assert.deepEqual(authorizedActors, ["human-1"]);
    await app.close();
  });

  it("rejects unsupported chat languages", async () => {
    const app = Fastify();
    await app.register(translationRoutes(translations, auth));

    const response = await app.inject({
      method: "POST",
      url: "/api/translations",
      payload: {
        actorId: "human-1",
        texts: ["Hello"],
        targetLanguage: "fr",
      },
    });

    assert.equal(response.statusCode, 400);
    await app.close();
  });
});
