import {
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
} from "@nats-io/jetstream";
import {
  connect,
  type NatsConnection,
} from "@nats-io/transport-node";
import type { FastifyBaseLogger } from "fastify";
import type { Pool } from "pg";

type PublisherStatus = "stopped" | "connecting" | "connected";

interface OutboxRow {
  id: string;
  subject: string;
  payload: unknown;
  attempts: number;
}

export interface EventPublisher {
  start(logger: FastifyBaseLogger): void;
  stop(): Promise<void>;
  status(): PublisherStatus;
}

export class JetStreamOutboxPublisher implements EventPublisher {
  private connection?: NatsConnection;
  private client?: JetStreamClient;
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<void>;
  private state: PublisherStatus = "stopped";
  private logger?: FastifyBaseLogger;
  private readonly encoder = new TextEncoder();

  public constructor(
    private readonly database: Pool,
    private readonly natsUrl: string,
  ) {}

  public start(logger: FastifyBaseLogger): void {
    if (this.timer !== undefined) {
      return;
    }

    this.logger = logger;
    this.state = "connecting";
    this.timer = setInterval(() => this.scheduleTick(), 1_000);
    this.timer.unref();
    this.scheduleTick();
  }

  public async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    this.state = "stopped";
    await this.activeTick;

    if (this.connection !== undefined) {
      try {
        await this.connection.drain();
      } catch (error) {
        this.logger?.error({ err: error }, "Failed to drain NATS connection");
      }

      this.connection = undefined;
      this.client = undefined;
    }
  }

  public status(): PublisherStatus {
    return this.state;
  }

  private async ensureClient(): Promise<JetStreamClient> {
    if (this.client !== undefined) {
      return this.client;
    }

    this.state = "connecting";
    const connection = await connect({
      servers: this.natsUrl,
      timeout: 2_000,
      maxReconnectAttempts: -1,
    });
    const manager = await jetstreamManager(connection);
    let streamExists = false;

    for await (const stream of manager.streams.list()) {
      if (stream.config.name === "ROOM_EVENTS") {
        streamExists = true;
        break;
      }
    }

    if (!streamExists) {
      await manager.streams.add({
        name: "ROOM_EVENTS",
        subjects: ["rooms.*.events.*"],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
      });
    }

    this.connection = connection;
    this.client = jetstream(connection);
    this.state = "connected";
    this.logger?.info("Connected event outbox to NATS JetStream");
    void connection.closed().then((error) => {
      if (this.connection !== connection) {
        return;
      }

      this.connection = undefined;
      this.client = undefined;
      this.state = this.timer === undefined ? "stopped" : "connecting";

      if (error !== undefined) {
        this.logger?.error({ err: error }, "NATS connection closed");
      }
    });

    return this.client;
  }

  private scheduleTick(): void {
    if (this.activeTick !== undefined || this.timer === undefined) {
      return;
    }

    this.activeTick = this.tick().finally(() => {
      this.activeTick = undefined;
    });
  }

  private async tick(): Promise<void> {
    try {
      const client = await this.ensureClient();
      const events = await this.claimBatch();

      for (const event of events) {
        try {
          await client.publish(
            event.subject,
            this.encoder.encode(JSON.stringify(event.payload)),
            { msgID: event.id },
          );
          await this.database.query(
            `
              UPDATE event_outbox
              SET published_at = now(), locked_until = NULL, last_error = NULL
              WHERE id = $1
            `,
            [event.id],
          );
        } catch (error) {
          await this.recordFailure(event, error);
        }
      }
    } catch (error) {
      this.state = "connecting";
      this.logger?.error({ err: error }, "Event outbox publication failed");
    }
  }

  private async claimBatch(): Promise<OutboxRow[]> {
    const result = await this.database.query<OutboxRow>(
      `
        WITH candidates AS (
          SELECT id
          FROM event_outbox
          WHERE published_at IS NULL
            AND available_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
          ORDER BY id
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        UPDATE event_outbox
        SET locked_until = now() + interval '30 seconds'
        WHERE id IN (SELECT id FROM candidates)
        RETURNING id::text, subject, payload, attempts
      `,
    );

    return result.rows;
  }

  private async recordFailure(
    event: OutboxRow,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const delaySeconds = Math.min(2 ** event.attempts, 60);

    await this.database.query(
      `
        UPDATE event_outbox
        SET
          attempts = attempts + 1,
          last_error = $2,
          available_at = now() + ($3 * interval '1 second'),
          locked_until = NULL
        WHERE id = $1
      `,
      [event.id, message.slice(0, 2_000), delaySeconds],
    );
    this.logger?.error(
      { err: error, outboxEventId: event.id },
      "Failed to publish outbox event",
    );
  }
}
