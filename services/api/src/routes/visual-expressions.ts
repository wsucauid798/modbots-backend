import type { FastifyPluginAsync } from "fastify";
import type { WriteAuthorizer } from "../domain/auth.js";
import { badRequest, notFound } from "../domain/errors.js";
import type { ActorRepository } from "../repositories/actors.js";
import type {
  MemeTemplate,
  ReactionGifTemplate,
  VisualExpressionService,
} from "../visual-expressions.js";

const memeTemplates = new Set<MemeTemplate>([
  "reaction",
  "contrast",
  "announcement",
]);
const gifTemplates = new Set<ReactionGifTemplate>([
  "celebrate",
  "laugh",
  "side_eye",
  "facepalm",
]);

const requestRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_body", "Request body must be a JSON object");
  }

  return value as Record<string, unknown>;
};

const requiredText = (
  body: Record<string, unknown>,
  name: string,
  maximumLength: number,
): string => {
  const value = body[name];

  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength
  ) {
    throw badRequest(
      "invalid_body",
      `'${name}' must be a non-empty string of at most ${maximumLength} characters`,
    );
  }

  return value.trim();
};

const filenameAuthor = (author: string): string =>
  author
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "participant";

export const visualExpressionRoutes = (
  actors: ActorRepository,
  auth: WriteAuthorizer,
  visuals: VisualExpressionService,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    const actorDisplay = async (
      authorization: string | undefined,
      body: Record<string, unknown>,
    ): Promise<string> => {
      const actorId = requiredText(body, "actorId", 200);
      await auth.authorizeActor(authorization, actorId);
      const actor = await actors.getById(actorId);

      if (actor === null) {
        throw notFound("actor_not_found", "Actor not found");
      }

      return actor.display;
    };

    app.post<{ Body: unknown }>("/api/expressions/memes", async (request) => {
      const body = requestRecord(request.body);
      const author = await actorDisplay(request.headers.authorization, body);
      const template = requiredText(body, "template", 30);
      const topText = requiredText(body, "topText", 180);
      const bottomText = requiredText(body, "bottomText", 180);

      if (!memeTemplates.has(template as MemeTemplate)) {
        throw badRequest("invalid_template", "Unknown meme template");
      }

      const rendered = await visuals.renderMeme({
        template: template as MemeTemplate,
        topText,
        bottomText,
        author,
      });

      return {
        ...rendered,
        filename: `${filenameAuthor(author)}-meme-${Date.now()}.svg`,
        caption: `Meme by ${author}`,
        altText: `Meme: ${topText}. ${bottomText}.`,
      };
    });

    app.post<{ Body: unknown }>(
      "/api/expressions/reaction-gifs",
      async (request) => {
        const body = requestRecord(request.body);
        const author = await actorDisplay(request.headers.authorization, body);
        const template = requiredText(body, "template", 30);
        const reactionText = requiredText(body, "text", 120);

        if (!gifTemplates.has(template as ReactionGifTemplate)) {
          throw badRequest("invalid_template", "Unknown reaction GIF template");
        }

        const rendered = await visuals.renderReactionGif({
          template: template as ReactionGifTemplate,
          text: reactionText,
          author,
        });

        return {
          ...rendered,
          filename: `${filenameAuthor(author)}-reaction-${Date.now()}.gif`,
          caption: `Reaction GIF by ${author}`,
          altText: `Animated ${template.replace("_", "-")} reaction: ${reactionText}.`,
        };
      },
    );
  };
};
