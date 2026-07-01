import type { FastifyPluginAsync } from "fastify";
import type { ActorType } from "../repositories/actors.js";
import type { CommandHandler } from "../domain/commands.js";
import { badRequest } from "../domain/errors.js";

interface RoomParams {
  roomId: string;
}

interface ProposalParams extends RoomParams {
  proposalId: string;
}

const actorTypes = new Set<ActorType>(["human", "chat_bot", "mod_bot"]);

const record = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("invalid_body", "Request body must be a JSON object");
  }

  return body as Record<string, unknown>;
};

const string = (
  body: Record<string, unknown>,
  field: string,
  options: { minimum?: number; maximum?: number } = {},
): string => {
  const value = body[field];

  if (typeof value !== "string") {
    throw badRequest("invalid_body", `'${field}' must be a string`);
  }

  const trimmed = value.trim();
  const minimum = options.minimum ?? 1;

  if (trimmed.length < minimum) {
    throw badRequest(
      "invalid_body",
      `'${field}' must contain at least ${minimum} character(s)`,
    );
  }

  if (options.maximum !== undefined && trimmed.length > options.maximum) {
    throw badRequest(
      "invalid_body",
      `'${field}' must not exceed ${options.maximum} characters`,
    );
  }

  return trimmed;
};

const actorId = (body: Record<string, unknown>, field: string): string => {
  const value = string(body, field, { maximum: 64 });

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value)) {
    throw badRequest(
      "invalid_actor_id",
      `'${field}' must be 3 to 64 letters, numbers, underscores, or hyphens`,
    );
  }

  return value;
};

const number = (
  body: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number => {
  const value = body[field];

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw badRequest(
      "invalid_body",
      `'${field}' must be a number between ${minimum} and ${maximum}`,
    );
  }

  return value;
};

const sequence = (body: Record<string, unknown>): string => {
  const value = body.targetEventSequence;

  if (
    (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) &&
    (typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1)
  ) {
    throw badRequest(
      "invalid_body",
      "'targetEventSequence' must be a positive integer",
    );
  }

  return String(value);
};

export const commandRoutes = (
  commands: CommandHandler,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.post<{ Body: unknown }>("/api/actors", async (request, reply) => {
      const body = record(request.body);
      const type = string(body, "type");

      if (!actorTypes.has(type as ActorType)) {
        throw badRequest(
          "invalid_actor_type",
          "'type' must be human, chat_bot, or mod_bot",
        );
      }

      const actor = await commands.createActor({
        id: actorId(body, "id"),
        displayName: string(body, "displayName", { maximum: 100 }),
        type: type as ActorType,
      });

      return reply.code(201).send(actor);
    });

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/presence",
      async (request, reply) => {
        const body = record(request.body);
        const state = string(body, "state");

        if (state !== "joined" && state !== "left") {
          throw badRequest(
            "invalid_presence_state",
            "'state' must be joined or left",
          );
        }

        const event = await commands.setPresence({
          roomId: request.params.roomId,
          actorId: actorId(body, "actorId"),
          state,
        });

        return reply.code(201).send(event);
      },
    );

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/messages",
      async (request, reply) => {
        const body = record(request.body);
        const event = await commands.postMessage({
          roomId: request.params.roomId,
          actorId: actorId(body, "actorId"),
          content: string(body, "content", { maximum: 4_000 }),
        });

        return reply.code(201).send(event);
      },
    );

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/moderation/proposals",
      async (request, reply) => {
        const body = record(request.body);
        const result = await commands.createModerationProposal({
          roomId: request.params.roomId,
          modBotId: actorId(body, "modBotId"),
          targetEventSequence: sequence(body),
          action: string(body, "action", { maximum: 100 }),
          confidence: number(body, "confidence", 0, 1),
          rationale: body.rationale ?? {},
          modelVersion: string(body, "modelVersion", { maximum: 200 }),
        });

        return reply.code(201).send(result);
      },
    );

    app.post<{ Params: ProposalParams; Body: unknown }>(
      "/api/rooms/:roomId/moderation/proposals/:proposalId/decision",
      async (request) => {
        const body = record(request.body);
        const decision = string(body, "decision");

        if (decision !== "accepted" && decision !== "rejected") {
          throw badRequest(
            "invalid_moderation_decision",
            "'decision' must be accepted or rejected",
          );
        }

        return commands.decideModerationProposal({
          roomId: request.params.roomId,
          proposalId: request.params.proposalId,
          reviewerActorId: actorId(body, "reviewerActorId"),
          decision,
        });
      },
    );
  };
};
