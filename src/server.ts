import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase, migrateDatabase } from "./database.js";
import { CommandService } from "./domain/commands.js";
import { ModerationPolicy } from "./domain/moderation-policy.js";
import { JetStreamOutboxPublisher } from "./events/outbox-publisher.js";
import { PostgresActorRepository } from "./repositories/actors.js";
import { PostgresModerationRepository } from "./repositories/moderation.js";
import { PostgresRoomRepository } from "./repositories/rooms.js";

const start = async (): Promise<void> => {
  const config = loadConfig();
  const database = createDatabase(config.database);
  const publisher = new JetStreamOutboxPublisher(database, config.natsUrl);
  const app = buildApp({
    actors: new PostgresActorRepository(database),
    commands: new CommandService(
      database,
      new ModerationPolicy(config.moderation),
    ),
    database,
    moderation: new PostgresModerationRepository(database),
    publisher,
    rooms: new PostgresRoomRepository(database),
  });

  try {
    await migrateDatabase(database);
    await app.listen({ host: config.server.host, port: config.server.port });
  } catch (error) {
    app.log.error(error);
    await database.end();
    process.exit(1);
  }
};

void start();
