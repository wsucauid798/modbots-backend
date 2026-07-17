import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { SessionWriteAuthorizer } from "../domain/auth.js";
import type { CommandHandler } from "../domain/commands.js";
import type { ActorRepository } from "../repositories/actors.js";
import type { CredentialRepository } from "../repositories/credentials.js";
import type { EventPublisher } from "../events/outbox-publisher.js";
import type { ModerationRepository } from "../repositories/moderation.js";
import type { RoomRepository } from "../repositories/rooms.js";
import type { SessionRepository } from "../repositories/sessions.js";
import { actorRoutes } from "./actors.js";
import { commandRoutes } from "./commands.js";
import { moderationRoutes } from "./moderation.js";
import { roomRoutes } from "./rooms.js";
import { sessionRoutes } from "./sessions.js";

const actors: ActorRepository = {
  getById: async (actorId) => {
    if (actorId === "human-1") {
      return {
        id: actorId,
        handle: null,
        displayName: "Test Human",
        discriminator: "0001",
        registered: false,
        display: "Test Human-0001",
        profilePictureId: null,
        profilePictureUrl: null,
        type: "human",
        policyVersionAccepted: null,
        policyAcceptedAt: null,
        retiredAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    }

    if (actorId === "chat-bot-1") {
      return {
        id: actorId,
        handle: null,
        displayName: "Helper",
        discriminator: null,
        registered: false,
        display: "Helper",
        profilePictureId: null,
        profilePictureUrl: null,
        type: "chat_bot",
        policyVersionAccepted: null,
        policyAcceptedAt: null,
        retiredAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    }

    return null;
  },
  getByHandle: async () => null,
  recordPolicyAcceptance: async () => null,
};

const sessions: SessionRepository = {
  issue: async () => ({
    token: "issued-raw-token",
    expiresAt: "2026-01-31T00:00:00.000Z",
  }),
  resolve: async (token) =>
    token === "human-1-token"
      ? { actorId: "human-1", actorType: "human" }
      : null,
  revoke: async (token) => token === "human-1-token",
};

const auth = new SessionWriteAuthorizer(sessions, actors, "optional");
const requiredAuth = new SessionWriteAuthorizer(sessions, actors, "required");

const credentials: CredentialRepository = {
  setPassword: async () => {},
  passwordHashFor: async () => null,
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
    id: "actor-1",
    handle: command.handle ?? null,
    displayName: command.displayName,
    discriminator: command.type === "human" ? "0001" : null,
    registered: command.registered ?? false,
    display:
      command.type === "human"
        ? `${command.displayName}${command.registered ? "#" : "-"}0001`
        : command.displayName,
    profilePictureId: null,
    profilePictureUrl: null,
    type: command.type,
    policyVersionAccepted: command.policyVersionAccepted ?? null,
    policyAcceptedAt:
      command.policyVersionAccepted === undefined
        ? null
        : "2026-01-01T00:00:00.000Z",
    retiredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  renameActor: async (command) => ({
    id: command.actorId,
    handle: null,
    displayName: command.displayName,
    discriminator: "0002",
    registered: false,
    display: `${command.displayName}-0002`,
    profilePictureId: null,
    profilePictureUrl: null,
    type: "human",
    policyVersionAccepted: null,
    policyAcceptedAt: null,
    retiredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  retireActor: async (command) => ({
    id: command.actorId,
    handle: null,
    displayName: "Retired",
    discriminator: "0003",
    registered: false,
    display: "Retired-0003",
    profilePictureId: null,
    profilePictureUrl: null,
    type: "human",
    policyVersionAccepted: null,
    policyAcceptedAt: null,
    retiredAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  restoreActor: async (command) => ({
    id: command.actorId,
    handle: null,
    displayName: "Restored",
    discriminator: "0004",
    registered: false,
    display: "Restored-0004",
    profilePictureId: null,
    profilePictureUrl: null,
    type: "human",
    policyVersionAccepted: null,
    policyAcceptedAt: null,
    retiredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  }),
  setPresence: async () => event,
  postMessage: async (command) => ({
    ...event,
    payload: {
      content: command.content,
      ...(command.addressedTo === undefined
        ? {}
        : { addressedTo: command.addressedTo }),
    },
  }),
  postContent: async (command) => ({
    contentItem: {
      contractVersion: 1,
      entityType: "content_item",
      contentItemId: "content-1",
      roomId: command.roomId,
      roomSequence: "2",
      actorId: command.actorId,
      createdAt: "2026-01-01T00:00:00.000Z",
      lifecycleState: "published",
      revision: 1,
      addressedTo: command.addressedTo ?? [],
      parts: command.parts.map((part, index) => ({
        partId: `part-${index + 1}`,
        kind: "text",
        text: part.text,
      })),
      references: command.references ?? [],
    },
    event: { ...event, type: "content_posted" },
  }),
  editContent: async () => {
    throw new Error("Not used by this test");
  },
  removeContent: async () => {
    throw new Error("Not used by this test");
  },
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
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/actors",
      payload: {
        displayName: "Second Human",
        type: "human",
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().displayName, "Second Human");
    await app.close();
  });

  it("rejects empty messages before reaching the command service", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

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

  it("passes message addressing to the command service", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      payload: {
        actorId: "human-1",
        content: "Helper, are you there?",
        addressedTo: [{ targetType: "actor", actorId: "chat-bot-1" }],
      },
    });

    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.json().payload.addressedTo, [
      { targetType: "actor", actorId: "chat-bot-1" },
    ]);
    await app.close();
  });

  it("serves the room rules with stable identifiers", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({ method: "GET", url: "/api/rules" });

    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().version, "string");
    assert.equal(typeof response.json().ethos, "string");
    assert.ok(Array.isArray(response.json().rules));
    assert.ok(response.json().rules.length > 0);
    assert.equal(typeof response.json().rules[0].id, "string");
    assert.equal(typeof response.json().rules[0].title, "string");
    assert.equal(typeof response.json().rules[0].text, "string");
    await app.close();
  });

  it("serves the participation policy", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({ method: "GET", url: "/api/policy" });

    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().version, "string");
    assert.match(response.json().moderationAccess, /moderat/i);
    await app.close();
  });

  it("requires policy acceptance before guest participation", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/guests",
      payload: { displayName: "Walk In" },
    });

    assert.equal(response.statusCode, 400);
    await app.close();
  });

  it("creates guests with an assigned name, consent, and a session", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/guests",
      payload: { acceptPolicy: true },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().actor.displayName, "Guest");
    assert.equal(response.json().actor.registered, false);
    assert.equal(typeof response.json().actor.policyVersionAccepted, "string");
    assert.equal(response.json().session.token, "issued-raw-token");
    assert.equal(
      response.json().session.expiresAt,
      "2026-01-31T00:00:00.000Z",
    );
    await app.close();
  });

  it("registers humans with a chosen username and a session", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/registrations",
      payload: {
        acceptPolicy: true,
        username: "arwen-fan",
        displayName: "Arwen Fan",
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().actor.registered, true);
    assert.equal(response.json().actor.handle, "arwen-fan");
    assert.equal(typeof response.json().session.token, "string");
    await app.close();
  });

  it("posts text content parts", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/content",
      payload: {
        actorId: "human-1",
        addressedTo: [{ targetType: "room" }],
        parts: [{ kind: "text", text: "Hello from the content path" }],
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().event.type, "content_posted");
    assert.equal(
      response.json().contentItem.parts[0].text,
      "Hello from the content path",
    );
    assert.deepEqual(response.json().contentItem.addressedTo, [
      { targetType: "room" },
    ]);
    await app.close();
  });

  it("rejects unsupported part kinds before the command service", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/content",
      payload: {
        actorId: "human-1",
        parts: [{ kind: "image", mediaAssetId: "asset-1" }],
      },
    });

    assert.equal(response.statusCode, 400);
    assert.match(response.json().message, /Only 'text' parts are supported/);
    await app.close();
  });
});

describe("session authentication", () => {
  it("exchanges an account token for an active guest actor", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ sub: "human-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const app = Fastify();

    try {
      await app.register(
        sessionRoutes(sessions, actors, "http://account.test"),
      );
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/exchange",
        payload: { accessToken: "account-token" },
      });

      assert.equal(response.statusCode, 201);
      assert.equal(response.json().actor.registered, false);
      assert.equal(response.json().session.token, "issued-raw-token");
    } finally {
      globalThis.fetch = originalFetch;
      await app.close();
    }
  });

  it("accepts a bearer session that matches the acting actor", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      headers: { authorization: "Bearer human-1-token" },
      payload: { actorId: "human-1", content: "Hello" },
    });

    assert.equal(response.statusCode, 201);
    await app.close();
  });

  it("rejects a bearer session that does not match the acting actor", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      headers: { authorization: "Bearer human-1-token" },
      payload: { actorId: "human-2", content: "Hello" },
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.json().message, /does not match the acting actor/);
    await app.close();
  });

  it("rejects a bearer token that does not resolve to a session", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      headers: { authorization: "Bearer unknown-token" },
      payload: { actorId: "human-1", content: "Hello" },
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.json().message, /does not resolve to a live session/);
    await app.close();
  });

  it("lets tokenless requests through unchanged in optional mode", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, auth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      payload: { actorId: "human-1", content: "Hello" },
    });

    assert.equal(response.statusCode, 201);
    await app.close();
  });

  it("refuses tokenless human writes in required mode", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, requiredAuth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      payload: { actorId: "human-1", content: "Hello" },
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.json().message, /must present a session token/);
    await app.close();
  });

  it("keeps bots exempt from required mode until service credentials exist", async () => {
    const app = Fastify();
    await app.register(commandRoutes(commands, sessions, requiredAuth, credentials));

    const response = await app.inject({
      method: "POST",
      url: "/api/rooms/global-lobby/messages",
      payload: { actorId: "chat-bot-1", content: "Hello" },
    });

    assert.equal(response.statusCode, 201);
    await app.close();
  });

  it("revokes the session of a live bearer token", async () => {
    const app = Fastify();
    await app.register(
      sessionRoutes(sessions, actors, "http://localhost:3003"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/revoke",
      headers: { authorization: "Bearer human-1-token" },
    });

    assert.equal(response.statusCode, 204);
    await app.close();
  });

  it("returns 401 when revoking an unknown token", async () => {
    const app = Fastify();
    await app.register(
      sessionRoutes(sessions, actors, "http://localhost:3003"),
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/revoke",
      headers: { authorization: "Bearer unknown-token" },
    });

    assert.equal(response.statusCode, 401);
    assert.match(response.json().message, /does not resolve to a live session/);
    await app.close();
  });
});
