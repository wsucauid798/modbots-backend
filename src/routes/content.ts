import type { FastifyPluginAsync } from "fastify";
import type { ContentRepository } from "../repositories/content.js";

interface RoomParams {
  roomId: string;
}

interface ContentParams extends RoomParams {
  contentItemId: string;
}

interface ContentQuery {
  after?: string;
  limit?: string;
}

const parseNonNegativeInteger = (
  value: string | undefined,
  fallback: number,
): number | null => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

export const contentRoutes = (
  content: ContentRepository,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.get<{ Params: RoomParams; Querystring: ContentQuery }>(
      "/api/rooms/:roomId/content",
      async (request, reply) => {
        const after = parseNonNegativeInteger(request.query.after, 0);
        const requestedLimit = parseNonNegativeInteger(request.query.limit, 100);

        if (after === null || requestedLimit === null || requestedLimit === 0) {
          return reply.code(400).send({
            error: "invalid_pagination",
            message: "'after' must be non-negative and 'limit' must be positive",
          });
        }

        const items = await content.listByRoom(request.params.roomId, {
          after,
          limit: Math.min(requestedLimit, 500),
        });

        if (items === null) {
          return reply.code(404).send({
            error: "room_not_found",
            message: `Room '${request.params.roomId}' does not exist`,
          });
        }

        return {
          data: items,
          nextCursor: items.at(-1)?.roomSequence ?? String(after),
        };
      },
    );

    app.get<{ Params: ContentParams }>(
      "/api/rooms/:roomId/content/:contentItemId",
      async (request, reply) => {
        const item = await content.getById(
          request.params.roomId,
          request.params.contentItemId,
        );

        if (item === null) {
          return reply.code(404).send({
            error: "content_item_not_found",
            message: `Content item '${request.params.contentItemId}' does not exist in this room`,
          });
        }

        return item;
      },
    );
  };
};
