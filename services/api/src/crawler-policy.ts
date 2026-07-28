import type { FastifyInstance } from "fastify";

const robots = "User-agent: *\nAllow: /\n";

export const registerCrawlerPolicy = (app: FastifyInstance): void => {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Robots-Tag", "noindex, nofollow");
    return payload;
  });

  app.get("/", async () => ({ service: "modbots-backend-api" }));

  app.get("/robots.txt", async (_request, reply) =>
    reply.type("text/plain; charset=utf-8").send(robots),
  );
};
