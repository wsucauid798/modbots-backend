import type { FastifyPluginAsync } from "fastify";
import type {
  ModerationProposalStatus,
  ModerationRepository,
} from "../repositories/moderation.js";

interface RoomParams {
  roomId: string;
}

interface ProposalsQuery {
  status?: string;
  limit?: string;
}

const statuses = new Set<ModerationProposalStatus>([
  "pending",
  "accepted",
  "rejected",
]);

const isStatus = (value: string): value is ModerationProposalStatus =>
  statuses.has(value as ModerationProposalStatus);

export const moderationRoutes = (
  moderation: ModerationRepository,
): FastifyPluginAsync => {
  return async (app): Promise<void> => {
    app.get<{ Params: RoomParams; Querystring: ProposalsQuery }>(
      "/api/rooms/:roomId/moderation/proposals",
      async (request, reply) => {
        const { status } = request.query;
        const limit = Number(request.query.limit ?? 100);

        if (status !== undefined && !isStatus(status)) {
          return reply.code(400).send({
            error: "invalid_status",
            message: "'status' must be pending, accepted, or rejected",
          });
        }

        if (!Number.isSafeInteger(limit) || limit < 1) {
          return reply.code(400).send({
            error: "invalid_limit",
            message: "'limit' must be a positive integer",
          });
        }

        const proposals = await moderation.listProposals(
          request.params.roomId,
          {
            status,
            limit: Math.min(limit, 500),
          },
        );

        if (proposals === null) {
          return reply.code(404).send({
            error: "room_not_found",
            message: `Room '${request.params.roomId}' does not exist`,
          });
        }

        return { data: proposals };
      },
    );
  };
};
