import type { FastifyPluginAsync } from "fastify";
import type { EventPublisher } from "../events/outbox-publisher.js";
import type { RoomRepository } from "../repositories/rooms.js";

interface RoomParams {
  roomId: string;
}

interface EventsQuery {
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

export const roomRoutes = (
  rooms: RoomRepository,
  publisher: EventPublisher,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.get<{ Params: RoomParams }>(
      "/api/rooms/:roomId/overview",
      async (request, reply) => {
        const overview = await rooms.getOverview(request.params.roomId);

        if (overview === null) {
          return reply.code(404).send({
            error: "room_not_found",
            message: `Room '${request.params.roomId}' does not exist`,
          });
        }

        return {
          ...overview,
          runtime: {
            backend: "healthy",
            eventStream: publisher.status(),
            persistence: "healthy",
          },
        };
      },
    );

    app.get<{ Params: RoomParams; Querystring: EventsQuery }>(
      "/api/rooms/:roomId/events",
      async (request, reply) => {
        const after = parseNonNegativeInteger(request.query.after, 0);
        const requestedLimit = parseNonNegativeInteger(request.query.limit, 100);

        if (after === null || requestedLimit === null || requestedLimit === 0) {
          return reply.code(400).send({
            error: "invalid_pagination",
            message: "'after' must be non-negative and 'limit' must be positive",
          });
        }

        const events = await rooms.listEvents(request.params.roomId, {
          after,
          limit: Math.min(requestedLimit, 500),
        });

        if (events === null) {
          return reply.code(404).send({
            error: "room_not_found",
            message: `Room '${request.params.roomId}' does not exist`,
          });
        }

        return {
          data: events,
          nextCursor: events.at(-1)?.sequence ?? String(after),
        };
      },
    );
  };
};
