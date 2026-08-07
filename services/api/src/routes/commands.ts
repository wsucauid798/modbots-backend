import type { FastifyPluginAsync } from "fastify";
import type { ActorType } from "../repositories/actors.js";
import type { SessionRepository } from "../repositories/sessions.js";
import type { WriteAuthorizer } from "../domain/auth.js";
import type {
  CommandHandler,
  ContentPartInput,
} from "../domain/commands.js";
import type {
  ContentAddress,
  ContentItemReference,
  ContentRelationship,
  ContentTargetReference,
} from "../repositories/content.js";
import type {
  ModerationEvidence,
  ModerationTarget,
} from "../repositories/moderation.js";
import { hashPassword } from "../domain/credentials.js";
import { badRequest, conflict, DomainError } from "../domain/errors.js";
import { participationPolicy } from "../domain/policy.js";
import { roomRules, ruleById } from "../domain/rules.js";
import type { CredentialRepository } from "../repositories/credentials.js";

interface RoomParams {
  roomId: string;
}

interface ProposalParams extends RoomParams {
  proposalId: string;
}

interface ActorParams {
  actorId: string;
}

interface RoomActorParams extends RoomParams, ActorParams {}

interface ContentParams extends RoomParams {
  contentItemId: string;
}

const actorTypes = new Set<ActorType>(["human", "chat_bot", "mod_bot"]);
const profileStatusPresets = new Set([
  "Available",
  "Away",
  "Busy",
  "Do not disturb",
]);

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

const optionalProfileString = (
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): string | null => {
  const value = body[field];

  if (value === null || value === "") {
    return null;
  }

  if (typeof value !== "string") {
    throw badRequest("invalid_body", `'${field}' must be a string or null`);
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.length > maximum) {
    throw badRequest(
      "invalid_body",
      `'${field}' must not exceed ${maximum} characters`,
    );
  }

  return trimmed;
};

const profileLinks = (body: Record<string, unknown>): string[] => {
  if (!Array.isArray(body.links) || body.links.length > 4) {
    throw badRequest("invalid_body", "'links' must be an array of up to 4 URLs");
  }

  return body.links.map((value, index) => {
    if (typeof value !== "string" || value.length > 2048) {
      throw badRequest(
        "invalid_body",
        `'links[${index}]' must be a URL of at most 2048 characters`,
      );
    }

    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw badRequest("invalid_body", `'links[${index}]' must be a valid URL`);
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw badRequest(
        "invalid_body",
        `'links[${index}]' must use HTTP or HTTPS`,
      );
    }

    return url.toString();
  });
};

const profileStatus = (
  body: Record<string, unknown>,
): {
  statusMode: "preset" | "custom" | "media" | null;
  statusText: string | null;
} => {
  if (body.statusMode === null && body.statusText === null) {
    return { statusMode: null, statusText: null };
  }

  if (body.statusMode === "media" && body.statusText === null) {
    return { statusMode: "media", statusText: null };
  }

  if (body.statusMode !== "preset" && body.statusMode !== "custom") {
    throw badRequest(
      "invalid_body",
      "'statusMode' must be 'preset', 'custom', 'media', or null",
    );
  }

  const statusText = string(body, "statusText", { maximum: 80 });

  if (body.statusMode === "preset" && !profileStatusPresets.has(statusText)) {
    throw badRequest("invalid_body", "'statusText' must be a supported preset");
  }

  return { statusMode: body.statusMode, statusText };
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

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw badRequest(
      "invalid_identifier",
      `'${label}' must be an identifier of 1 to 255 letters, numbers, or ._:- characters`,
    );
  }

  return value;
};

const asRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest("invalid_body", `'${label}' must be a JSON object`);
  }

  return value as Record<string, unknown>;
};

const contentParts = (body: Record<string, unknown>): ContentPartInput[] => {
  if (!Array.isArray(body.parts) || body.parts.length === 0) {
    throw badRequest(
      "invalid_content_parts",
      "'parts' must be a non-empty array",
    );
  }

  return body.parts.map((raw, index) => {
    const part = asRecord(raw, `parts[${index}]`);

    if (part.kind === "text") {
      if (typeof part.text !== "string") {
        throw badRequest(
          "invalid_content_parts",
          `'parts[${index}].text' must be a string`,
        );
      }

      const input: ContentPartInput = { kind: "text", text: part.text };

      if (part.language !== undefined) {
        if (
          typeof part.language !== "string" ||
          part.language.length < 2 ||
          part.language.length > 35
        ) {
          throw badRequest(
            "invalid_content_parts",
            `'parts[${index}].language' must be 2 to 35 characters`,
          );
        }

        input.language = part.language;
      }

      if (part.sourceText !== undefined || part.sourceLanguage !== undefined) {
        if (
          typeof part.sourceText !== "string" ||
          part.sourceText.trim().length === 0 ||
          part.sourceText.length > 4_000 ||
          typeof part.sourceLanguage !== "string" ||
          part.sourceLanguage.length < 2 ||
          part.sourceLanguage.length > 35
        ) {
          throw badRequest(
            "invalid_content_parts",
            `'parts[${index}]' must contain valid paired sourceText and sourceLanguage values`,
          );
        }

        input.sourceText = part.sourceText;
        input.sourceLanguage = part.sourceLanguage;
      }

      if (part.partId !== undefined) {
        input.partId = identifier(part.partId, `parts[${index}].partId`);
      }

      return input;
    }

    if (
      part.kind !== "image" &&
      part.kind !== "audio" &&
      part.kind !== "video" &&
      part.kind !== "file"
    ) {
      throw badRequest(
        "invalid_part_kind",
        "Part kind must be text, image, audio, video, or file",
      );
    }

    const input: ContentPartInput = {
      kind: part.kind,
      mediaAssetId: identifier(
        part.mediaAssetId,
        `parts[${index}].mediaAssetId`,
      ),
    };

    for (const field of ["caption", "altText"] as const) {
      if (part[field] !== undefined) {
        if (typeof part[field] !== "string" || part[field].length > 4_096) {
          throw badRequest(
            "invalid_content_parts",
            `'parts[${index}].${field}' must be a string of at most 4096 characters`,
          );
        }

        input[field] = part[field];
      }
    }

    if (part.partId !== undefined) {
      input.partId = identifier(part.partId, `parts[${index}].partId`);
    }

    return input;
  });
};

const optionalReplyTo = (
  body: Record<string, unknown>,
): ContentItemReference | undefined => {
  if (body.replyTo === undefined || body.replyTo === null) {
    return undefined;
  }

  const raw = asRecord(body.replyTo, "replyTo");
  const reference: ContentItemReference = {
    contentItemId: identifier(raw.contentItemId, "replyTo.contentItemId"),
  };

  if (raw.contentPartId !== undefined) {
    reference.contentPartId = identifier(
      raw.contentPartId,
      "replyTo.contentPartId",
    );
  }

  return reference;
};

const optionalAddressedTo = (
  body: Record<string, unknown>,
): ContentAddress[] | undefined => {
  if (body.addressedTo === undefined || body.addressedTo === null) {
    return undefined;
  }

  if (!Array.isArray(body.addressedTo)) {
    throw badRequest("invalid_addressing", "'addressedTo' must be an array");
  }

  if (body.addressedTo.length === 0 || body.addressedTo.length > 16) {
    throw badRequest(
      "invalid_addressing",
      "'addressedTo' must contain 1 to 16 targets",
    );
  }

  return body.addressedTo.map((raw, index) => {
    const target = asRecord(raw, `addressedTo[${index}]`);

    switch (target.targetType) {
      case "room":
        return { targetType: "room" };
      case "actor":
        return {
          targetType: "actor",
          actorId: actorId(target, "actorId"),
        };
      default:
        throw badRequest(
          "invalid_addressing",
          `'addressedTo[${index}].targetType' must be room or actor`,
        );
    }
  });
};

const relationshipTypes = new Set(["quotes", "mentions", "context"]);

const referenceTarget = (
  raw: Record<string, unknown>,
  label: string,
): ContentTargetReference => {
  switch (raw.targetType) {
    case "content_item":
      return {
        targetType: "content_item",
        contentItemId: identifier(raw.contentItemId, `${label}.contentItemId`),
      };
    case "content_part":
      return {
        targetType: "content_part",
        contentItemId: identifier(raw.contentItemId, `${label}.contentItemId`),
        contentPartId: identifier(raw.contentPartId, `${label}.contentPartId`),
      };
    case "media_asset":
      return {
        targetType: "media_asset",
        mediaAssetId: identifier(raw.mediaAssetId, `${label}.mediaAssetId`),
      };
    case "voice_session":
      return {
        targetType: "voice_session",
        voiceSessionId: identifier(
          raw.voiceSessionId,
          `${label}.voiceSessionId`,
        ),
      };
    case "voice_segment":
      return {
        targetType: "voice_segment",
        voiceSegmentId: identifier(
          raw.voiceSegmentId,
          `${label}.voiceSegmentId`,
        ),
      };
    default:
      throw badRequest(
        "invalid_content_references",
        `'${label}.targetType' must be a known target type`,
      );
  }
};

const optionalReferences = (
  body: Record<string, unknown>,
): ContentRelationship[] | undefined => {
  if (body.references === undefined || body.references === null) {
    return undefined;
  }

  if (!Array.isArray(body.references)) {
    throw badRequest(
      "invalid_content_references",
      "'references' must be an array",
    );
  }

  return body.references.map((raw, index) => {
    const reference = asRecord(raw, `references[${index}]`);

    if (
      typeof reference.relationshipType !== "string" ||
      !relationshipTypes.has(reference.relationshipType)
    ) {
      throw badRequest(
        "invalid_content_references",
        `'references[${index}].relationshipType' must be quotes, mentions, or context`,
      );
    }

    return {
      relationshipType: reference.relationshipType as
        | "quotes"
        | "mentions"
        | "context",
      target: referenceTarget(
        asRecord(reference.target, `references[${index}].target`),
        `references[${index}].target`,
      ),
    };
  });
};

const moderationTarget = (
  raw: Record<string, unknown>,
  label: string,
): ModerationTarget => {
  if (raw.targetType === "actor") {
    return {
      targetType: "actor",
      actorId: identifier(raw.actorId, `${label}.actorId`),
    };
  }

  return referenceTarget(raw, label);
};

const optionalModerationTarget = (
  body: Record<string, unknown>,
): ModerationTarget | undefined => {
  if (body.target === undefined || body.target === null) {
    return undefined;
  }

  return moderationTarget(asRecord(body.target, "target"), "target");
};

const optionalModerationEvidence = (
  body: Record<string, unknown>,
): ModerationEvidence[] | undefined => {
  if (body.evidence === undefined || body.evidence === null) {
    return undefined;
  }

  if (!Array.isArray(body.evidence)) {
    throw badRequest(
      "invalid_moderation_evidence",
      "'evidence' must be an array",
    );
  }

  return body.evidence.map((raw, index) => {
    const entry = asRecord(raw, `evidence[${index}]`);
    const result: ModerationEvidence = {
      target: moderationTarget(
        asRecord(entry.target, `evidence[${index}].target`),
        `evidence[${index}].target`,
      ),
    };

    if (entry.note !== undefined) {
      if (typeof entry.note !== "string" || entry.note.length > 4_096) {
        throw badRequest(
          "invalid_moderation_evidence",
          `'evidence[${index}].note' must be a string of at most 4096 characters`,
        );
      }

      result.note = entry.note;
    }

    return result;
  });
};

// Every human participant, guest or registered, accepts the participation
// policy. The accepted version is recorded on the actor as consent.
const requirePolicyAcceptance = (body: Record<string, unknown>): string => {
  if (body.acceptPolicy !== true) {
    throw badRequest(
      "policy_not_accepted",
      `Participation requires accepting policy version ${participationPolicy.version}`,
    );
  }

  return participationPolicy.version;
};

// A moderation proposal may cite the room rule it enforces.
const optionalRuleId = (body: Record<string, unknown>): string | undefined => {
  if (body.ruleId === undefined || body.ruleId === null) {
    return undefined;
  }

  const value = string(body, "ruleId", { maximum: 64 });

  if (ruleById(value) === undefined) {
    throw badRequest(
      "unknown_rule",
      "'ruleId' must be one of the room's rule identifiers",
    );
  }

  return value;
};

const optionalHandle = (
  body: Record<string, unknown>,
): string | undefined => {
  if (body.handle === undefined || body.handle === null) {
    return undefined;
  }

  const value = string(body, "handle", { maximum: 64 });

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(value)) {
    throw badRequest(
      "invalid_handle",
      "'handle' must be 3 to 64 letters, numbers, underscores, or hyphens",
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
  sessions: SessionRepository,
  auth: WriteAuthorizer,
  credentials: CredentialRepository,
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

      let registered: boolean | undefined;

      if (body.registered !== undefined) {
        if (typeof body.registered !== "boolean") {
          throw badRequest("invalid_body", "'registered' must be a boolean");
        }

        registered = body.registered;
      }

      const actor = await commands.createActor({
        displayName: string(body, "displayName", { maximum: 100 }),
        type: type as ActorType,
        handle: optionalHandle(body),
        registered,
      });

      return reply.code(201).send(actor);
    });

    app.patch<{ Params: ActorParams; Body: unknown }>(
      "/api/actors/:actorId",
      async (request, reply) => {
        const body = record(request.body);
        const actor = await commands.renameActor({
          actorId: request.params.actorId,
          displayName: string(body, "displayName", { maximum: 100 }),
        });

        return reply.code(200).send(actor);
      },
    );

    app.patch<{ Params: ActorParams; Body: unknown }>(
      "/api/actors/:actorId/profile",
      async (request, reply) => {
        await auth.authorizeActor(
          request.headers.authorization,
          request.params.actorId,
        );
        const body = record(request.body);
        const actor = await commands.updateActorProfile({
          actorId: request.params.actorId,
          bio: optionalProfileString(body, "bio", 160),
          pronouns: optionalProfileString(body, "pronouns", 40),
          location: optionalProfileString(body, "location", 80),
          links: profileLinks(body),
        });

        return reply.code(200).send(actor);
      },
    );

    app.patch<{ Params: RoomActorParams; Body: unknown }>(
      "/api/rooms/:roomId/actors/:actorId/status",
      async (request, reply) => {
        await auth.authorizeActor(
          request.headers.authorization,
          request.params.actorId,
        );
        const status = profileStatus(record(request.body));
        const result = await commands.updateActorStatus({
          roomId: request.params.roomId,
          actorId: request.params.actorId,
          ...status,
        });

        return reply.code(200).send(result.actor);
      },
    );

    app.patch<{ Params: RoomActorParams; Body: unknown }>(
      "/api/rooms/:roomId/actors/:actorId/media-playback",
      async (request, reply) => {
        await auth.authorizeActor(
          request.headers.authorization,
          request.params.actorId,
        );
        const body = record(request.body);
        const mediaAssetId =
          body.mediaAssetId === null
            ? null
            : string(body, "mediaAssetId", { maximum: 128 });
        const result = await commands.updateMediaPlayback({
          roomId: request.params.roomId,
          actorId: request.params.actorId,
          mediaAssetId,
        });
        return reply.code(200).send(result.actor);
      },
    );

    app.post<{ Params: ActorParams }>(
      "/api/actors/:actorId/retire",
      async (request, reply) => {
        const actor = await commands.retireActor({
          actorId: request.params.actorId,
        });

        return reply.code(200).send(actor);
      },
    );

    app.post<{ Params: ActorParams }>(
      "/api/actors/:actorId/restore",
      async (request, reply) => {
        const actor = await commands.restoreActor({
          actorId: request.params.actorId,
        });

        return reply.code(200).send(actor);
      },
    );

    app.get("/api/policy", async () => participationPolicy);

    app.get("/api/rules", async () => roomRules);

    app.post<{ Body: unknown }>("/api/guests", async (request, reply) => {
      const body = record(request.body);
      const policyVersion = requirePolicyAcceptance(body);
      const displayName =
        body.displayName === undefined || body.displayName === null
          ? "Guest"
          : string(body, "displayName", { maximum: 100 });

      const actor = await commands.createActor({
        displayName,
        type: "human",
        registered: false,
        policyVersionAccepted: policyVersion,
      });
      const session = await sessions.issue(actor.id);

      return reply.code(201).send({ actor, session });
    });

    app.post<{ Body: unknown }>(
      "/api/registrations",
      async (request, reply) => {
        const body = record(request.body);
        const policyVersion = requirePolicyAcceptance(body);
        const username = string(body, "username", { maximum: 64 });

        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/.test(username)) {
          throw badRequest(
            "invalid_username",
            "'username' must be 3 to 64 letters, numbers, underscores, or hyphens",
          );
        }

        const displayName =
          body.displayName === undefined || body.displayName === null
            ? username
            : string(body, "displayName", { maximum: 100 });

        // Passwords are optional while in-app registration still exists;
        // the account surface always sends one. Never trimmed: a password
        // is stored as typed.
        let password: string | null = null;

        if (body.password !== undefined && body.password !== null) {
          if (typeof body.password !== "string") {
            throw badRequest("invalid_body", "'password' must be a string");
          }

          if (body.password.length < 8 || body.password.length > 200) {
            throw badRequest(
              "invalid_password",
              "'password' must be 8 to 200 characters",
            );
          }

          password = body.password;
        }

        try {
          const actor = await commands.createActor({
            displayName,
            type: "human",
            handle: username,
            registered: true,
            policyVersionAccepted: policyVersion,
          });

          if (password !== null) {
            await credentials.setPassword(actor.id, await hashPassword(password));
          }

          const session = await sessions.issue(actor.id);

          return reply.code(201).send({ actor, session });
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "actor_handle_taken"
          ) {
            throw conflict(
              "username_taken",
              `Username '${username}' is already taken`,
            );
          }

          throw error;
        }
      },
    );

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

        const acting = actorId(body, "actorId");
        await auth.authorizeActor(request.headers.authorization, acting);

        const event = await commands.setPresence({
          roomId: request.params.roomId,
          actorId: acting,
          state,
        });

        return reply.code(201).send(event);
      },
    );

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/messages",
      async (request, reply) => {
        const body = record(request.body);
        const acting = actorId(body, "actorId");
        await auth.authorizeActor(request.headers.authorization, acting);

        let source:
          | { sourceText: string; sourceLanguage: string }
          | undefined;

        if (body.sourceText !== undefined || body.sourceLanguage !== undefined) {
          if (
            typeof body.sourceText !== "string" ||
            body.sourceText.trim().length === 0 ||
            body.sourceText.length > 4_000 ||
            typeof body.sourceLanguage !== "string" ||
            body.sourceLanguage.length < 2 ||
            body.sourceLanguage.length > 35
          ) {
            throw badRequest(
              "invalid_body",
              "'sourceText' and 'sourceLanguage' must be supplied together",
            );
          }

          source = {
            sourceText: body.sourceText,
            sourceLanguage: body.sourceLanguage,
          };
        }

        const event = await commands.postMessage({
          roomId: request.params.roomId,
          actorId: acting,
          content: string(body, "content", { maximum: 4_000 }),
          ...source,
          replyTo: optionalReplyTo(body),
          addressedTo: optionalAddressedTo(body),
        });

        return reply.code(201).send(event);
      },
    );

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/content",
      async (request, reply) => {
        const body = record(request.body);
        const acting = actorId(body, "actorId");
        await auth.authorizeActor(request.headers.authorization, acting);

        const result = await commands.postContent({
          roomId: request.params.roomId,
          actorId: acting,
          parts: contentParts(body),
          replyTo: optionalReplyTo(body),
          addressedTo: optionalAddressedTo(body),
          references: optionalReferences(body),
        });

        return reply.code(201).send(result);
      },
    );

    app.patch<{ Params: ContentParams; Body: unknown }>(
      "/api/rooms/:roomId/content/:contentItemId",
      async (request, reply) => {
        const body = record(request.body);
        const acting = actorId(body, "actorId");
        await auth.authorizeActor(request.headers.authorization, acting);

        const result = await commands.editContent({
          roomId: request.params.roomId,
          contentItemId: request.params.contentItemId,
          actorId: acting,
          parts: contentParts(body),
        });

        return reply.code(200).send(result);
      },
    );

    app.post<{ Params: ContentParams; Body: unknown }>(
      "/api/rooms/:roomId/content/:contentItemId/remove",
      async (request, reply) => {
        const body = record(request.body);
        const acting = actorId(body, "actorId");
        await auth.authorizeActor(request.headers.authorization, acting);

        const result = await commands.removeContent({
          roomId: request.params.roomId,
          contentItemId: request.params.contentItemId,
          actorId: acting,
        });

        return reply.code(200).send(result);
      },
    );

    app.post<{ Params: RoomParams; Body: unknown }>(
      "/api/rooms/:roomId/moderation/proposals",
      async (request, reply) => {
        const body = record(request.body);
        const modBotId = actorId(body, "modBotId");
        await auth.authorizeActor(request.headers.authorization, modBotId);

        const result = await commands.createModerationProposal({
          roomId: request.params.roomId,
          modBotId,
          target: optionalModerationTarget(body),
          targetEventSequence:
            body.targetEventSequence === undefined ? undefined : sequence(body),
          evidence: optionalModerationEvidence(body),
          action: string(body, "action", { maximum: 100 }),
          ruleId: optionalRuleId(body),
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

        const reviewerActorId = actorId(body, "reviewerActorId");
        await auth.authorizeActor(
          request.headers.authorization,
          reviewerActorId,
        );

        return commands.decideModerationProposal({
          roomId: request.params.roomId,
          proposalId: request.params.proposalId,
          reviewerActorId,
          decision,
        });
      },
    );
  };
};
