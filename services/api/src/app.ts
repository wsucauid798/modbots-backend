import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { WriteAuthorizer } from "./domain/auth.js";
import type { CommandService } from "./domain/commands.js";
import { DomainError } from "./domain/errors.js";
import type { EventPublisher } from "./events/outbox-publisher.js";
import type { ActorRepository } from "./repositories/actors.js";
import type { ContentRepository } from "./repositories/content.js";
import type { CredentialRepository } from "./repositories/credentials.js";
import type { ModerationRepository } from "./repositories/moderation.js";
import type { MediaRepository } from "./repositories/media.js";
import type { RoomRepository } from "./repositories/rooms.js";
import type { SessionRepository } from "./repositories/sessions.js";
import { actorRoutes } from "./routes/actors.js";
import { commandRoutes } from "./routes/commands.js";
import { contentRoutes } from "./routes/content.js";
import { credentialRoutes } from "./routes/credentials.js";
import { healthRoutes } from "./routes/health.js";
import { inferenceRoutes } from "./routes/inference.js";
import { moderationRoutes } from "./routes/moderation.js";
import { mediaRoutes } from "./routes/media.js";
import { roomRoutes } from "./routes/rooms.js";
import { sessionRoutes } from "./routes/sessions.js";

export interface AppDependencies {
  accountUrl: string;
  database: Pool;
  actors: ActorRepository;
  auth: WriteAuthorizer;
  commands: CommandService;
  content: ContentRepository;
  credentials: CredentialRepository;
  moderation: ModerationRepository;
  media: MediaRepository;
  inferenceManifest: Record<string, unknown>;
  publisher: EventPublisher;
  rooms: RoomRepository;
  sessions: SessionRepository;
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
  app.register(inferenceRoutes(dependencies.inferenceManifest));
  app.register(actorRoutes(dependencies.actors));
  app.register(roomRoutes(dependencies.rooms, dependencies.publisher));
  app.register(contentRoutes(dependencies.content));
  app.register(moderationRoutes(dependencies.moderation));
  app.register(mediaRoutes(dependencies.media, dependencies.auth));
  app.register(
    sessionRoutes(
      dependencies.sessions,
      dependencies.actors,
      dependencies.accountUrl,
    ),
  );
  app.register(credentialRoutes(dependencies.actors, dependencies.credentials));
  app.register(
    commandRoutes(
      dependencies.commands,
      dependencies.sessions,
      dependencies.auth,
      dependencies.credentials,
    ),
  );
  app.addHook("onReady", async () => {
    dependencies.publisher.start(app.log);
  });
  app.addHook("onClose", async () => {
    await dependencies.publisher.stop();
    await dependencies.database.end();
  });

  return app;
};
