import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import type { CommandHandler } from "../domain/commands.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { EventPublisher } from "../events/outbox-publisher.js";
import type { ModerationRepository } from "../repositories/moderation.js";
import type { RoomRepository } from "../repositories/rooms.js";
import { actorRoutes } from "./actors.js";
import { commandRoutes } from "./commands.js";
import { moderationRoutes } from "./moderation.js";
import { roomRoutes } from "./rooms.js";

const actors: ActorRepository = {
  getById: async (actorId) =>
    actorId === "human-1"
      ? {
          id: actorId,
          displayName: "Test Human",
          type: "human",
          createdAt: "2026-01-01T00:00:00.000Z",
        }
      : null,
};

const rooms: RoomRepository = {
  getOverview: async (roomId) =>
    roomId === "global-lobby"
      ? {
          room: {
            id: roomId,
            name: "Global Lobby",
            actorsOnline: 0,
            chatBotsOnline: 0,
            modBotsOnline: 0,
          },
          moderation: {
            proposalsPending: 0,
            proposalsAccepted: 0,
            proposalsRejected: 0,
          },
        }
      : null,
  listEvents: async (roomId) => (roomId === "global-lobby" ? [] : null),
};

const moderation: ModerationRepository = {
  listProposals: async (roomId) => (roomId === "global-lobby" ? [] : null),
};

const publisher: EventPublisher = {
  start: () => undefined,
  stop: async () => undefined,
  status: () => "connected",
};

const event = {
  sequence: "1",
  type: "message_posted",
  actorId: "human-1",
  payload: { content: "Hello" },
  occurredAt: "2026-01-01T00:00:00.000Z",
};

const commands: CommandHandler = {
  createActor: async (command) => ({
    id: command.id,
    displayName: command.displayName,
    type: command.type,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  setPresence: async () => event,
  postMessage: async () => event,
  createModerationProposal: async () => {
    throw new Error("Not used by this test");
  },
  decideModerationProposal: async () => {
    throw new Error("Not used by this test");
  },
};

describe("actor routes", () => {
  it("returns an actor and reports missing actors", async () => {
    const app = Fastify();
    await app.register(actorRoutes(actors));

    const actorResponse = await app.inject({
      method: "GET",
      url: "/api/actors/human-1",
    });
    const missingResponse = await app.inject({
      method: "GET",
      url: "/api/actors/missing",
    });

    assert.equal(actorResponse.statusCode, 200);
    assert.equal(actorResponse.json().type, "human");
    assert.equal(missingResponse.statusCode, 404);
    await app.close();
  });
});

describe("room routes", () => {
  it("returns persisted room overview data", async () => {
    const app = Fastify();
    await app.register(roomRoutes(rooms, publisher));

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms/global-lobby/overview",
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().room.actorsOnline, 0);
    assert.equal(response.json().runtime.persistence, "healthy");
    await app.close();
  });

  it("validates event pagination", async () => {
    const app = Fastify();
    await app.register(roomRoutes(rooms, publisher));

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms/global-lobby/events?limit=0",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_pagination");
    await app.close();
  });
});

describe("moderation routes", () => {
  it("validates proposal status filters", async () => {
    const app = Fastify();
    await app.register(moderationRoutes(moderation));

    const response = await app.inject({
      method: "GET",
      url: "/api/rooms/global-lobby/moderation/proposals?status=unknown",
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_status");
    await app.close();
  });
});

describe("command routes", () => {
  it("creates a validated actor", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands));

    const response = await app.inject({
      method: "POST",
      url: "/api/actors",
      payload: {
        id: "human-2",
        displayName: "Second Human",
        type: "human",
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().id, "human-2");
    await app.close();
  });

  it("rejects empty messages before reaching the command service", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      payload: {
        actorId: "human-1",
        content: " ",
      },
    });

    assert.equal(response.statusCode, 400);
    await app.close();
  });
});
