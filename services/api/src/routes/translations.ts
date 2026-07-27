import type { FastifyPluginAsync } from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import { badRequest } from "../domain/errors.js";
import type {
  SupportedChatLanguage,
  TranslationService,
} from "../translation.js";

const supportedLanguages = new Set<SupportedChatLanguage>(["en", "zh-CN"]);

const requestRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_body", "Request body must be a JSON object");
  }

  return value as Record<string, unknown>;
};

export const translationRoutes = (
  translations: TranslationService,
  auth: WriteAuthorizer,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post<{ Body: unknown }>("/api/translations", async (request) => {
      const body = requestRecord(request.body);
      const actorId = body.actorId;
      const sourceLanguage = body.sourceLanguage ?? "auto";
      const targetLanguage = body.targetLanguage;
      const texts = body.texts;

      if (typeof actorId !== "string" || actorId.length === 0) {
        throw badRequest("invalid_body", "'actorId' must be a non-empty string");
      }

      await auth.authorizeActor(request.headers.authorization, actorId);

      if (
        typeof sourceLanguage !== "string" ||
        sourceLanguage.length < 2 ||
        sourceLanguage.length > 35
      ) {
        throw badRequest(
          "invalid_body",
          "'sourceLanguage' must contain 2 to 35 characters",
        );
      }

      if (
        typeof targetLanguage !== "string" ||
        !supportedLanguages.has(targetLanguage as SupportedChatLanguage)
      ) {
        throw badRequest(
          "unsupported_language",
          "'targetLanguage' must be en or zh-CN",
        );
      }

      if (
        !Array.isArray(texts) ||
        texts.length === 0 ||
        texts.length > 50 ||
        texts.some(
          (text) =>
            typeof text !== "string" ||
            text.trim().length === 0 ||
            text.length > 4_000,
        ) ||
        texts.reduce(
          (length, text) => length + (typeof text === "string" ? text.length : 0),
          0,
        ) > 40_000
      ) {
        throw badRequest(
          "invalid_body",
          "'texts' must contain 1 to 50 non-empty strings and at most 40,000 characters",
        );
      }

      return {
        translations: await translations.translate({
          texts: texts as string[],
          sourceLanguage,
          targetLanguage: targetLanguage as SupportedChatLanguage,
        }),
      };
    });
  };
};
