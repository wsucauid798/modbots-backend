import type { FastifyPluginAsync } from "fastify";
import type { Pool } from "pg";
import type { EventPublisher } from "../events/outbox-publisher.js";

export const healthRoutes = (
  database: Pool,
  publisher: EventPublisher,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.get("/health", async (_request, reply) => {
      try {
        await database.query("SELECT 1");

        return {
          status: "ok",
          service: "modbots-backend-api",
          dependencies: {
            nats: publisher.status(),
            postgres: "healthy",
          },
        };
      } catch {
        return reply.code(503).send({
          status: "unavailable",
          service: "modbots-backend-api",
          dependencies: {
            nats: publisher.status(),
            postgres: "unhealthy",
          },
        });
      }
    });
  };
};
