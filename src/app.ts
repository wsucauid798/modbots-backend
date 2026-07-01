import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { CommandService } from "./domain/commands.js";
import { DomainError } from "./domain/errors.js";
import type { EventPublisher } from "./events/outbox-publisher.js";
import type { ActorRepository } from "./repositories/actors.js";
import type { ModerationRepository } from "./repositories/moderation.js";
import type { RoomRepository } from "./repositories/rooms.js";
import { actorRoutes } from "./routes/actors.js";
import { commandRoutes } from "./routes/commands.js";
import { healthRoutes } from "./routes/health.js";
import { moderationRoutes } from "./routes/moderation.js";
import { roomRoutes } from "./routes/rooms.js";

export interface AppDependencies {
  database: Pool;
  actors: ActorRepository;
  commands: CommandService;
  moderation: ModerationRepository;
  publisher: EventPublisher;
  rooms: RoomRepository;
}

export const buildApp = (dependencies: AppDependencies): FastifyInstance => {
  const app = Fastify({
    logger: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
      });
    }

    const statusCode =
      error instanceof Error && "statusCode" in error
        ? error.statusCode
        : undefined;

    if (
      typeof statusCode === "number" &&
      statusCode >= 400 &&
      statusCode < 500
    ) {
      return reply.code(statusCode).send({
        error: "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request",
      });
    }

    app.log.error(error);
    return reply.code(500).send({
      error: "internal_server_error",
      message: "An unexpected error occurred",
    });
  });

  app.register(healthRoutes(dependencies.database, dependencies.publisher));
  app.register(actorRoutes(dependencies.actors));
  app.register(roomRoutes(dependencies.rooms, dependencies.publisher));
  app.register(moderationRoutes(dependencies.moderation));
  app.register(commandRoutes(dependencies.commands));
  app.addHook("onReady", async () => {
    dependencies.publisher.start(app.log);
  });
  app.addHook("onClose", async () => {
    await dependencies.publisher.stop();
    await dependencies.database.end();
  });

  return app;
};
