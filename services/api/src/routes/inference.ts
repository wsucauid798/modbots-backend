import type { FastifyPluginAsync } from "fastify";

export type InferenceManifest = Record<string, unknown>;

export const inferenceRoutes = (
  manifest: InferenceManifest,
): FastifyPluginAsync => async (app) => {
  app.get("/api/inference/manifest", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=300");
    return manifest;
  });
};
