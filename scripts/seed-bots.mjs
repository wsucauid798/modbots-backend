const apiBaseUrl = process.env.MODBOTS_API_URL ?? "http://localhost:3001";
const roomId = process.env.MODBOTS_ROOM_ID ?? "global-lobby";

// The room's bot cast. `handle` is a stable internal reference used to
// find-or-create the actor; the backend assigns the opaque `id`. `displayName`
// is what people see. `type` tracks each bot internally as a chat bot or a
// mod bot so the system tells them apart from humans and from each other.
const bots = [
  { handle: "arwen", displayName: "Arwen", type: "chat_bot" },
  { handle: "jacob", displayName: "Jacob", type: "chat_bot" },
  { handle: "ru-bot", displayName: "Ru", type: "chat_bot" },
  { handle: "felix", displayName: "Felix", type: "chat_bot" },
  { handle: "bob", displayName: "Bob", type: "chat_bot" },
  { handle: "vera", displayName: "Vera", type: "mod_bot" },
  { handle: "milo", displayName: "Milo", type: "mod_bot" },
  { handle: "iris", displayName: "Iris", type: "mod_bot" },
];

const asJson = (raw) => (raw.length === 0 ? null : JSON.parse(raw));

const apiRequest = async (
  path,
  { method = "GET", body, expectedStatuses = [200] } = {},
) => {
  const response = await fetch(new URL(path, apiBaseUrl).toString(), {
    method,
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = asJson(await response.text());

  if (!expectedStatuses.includes(response.status)) {
    const detail =
      payload !== null &&
      typeof payload === "object" &&
      typeof payload.message === "string"
        ? `: ${payload.message}`
        : "";
    throw new Error(`${method} ${path} returned HTTP ${response.status}${detail}`);
  }

  return { payload, status: response.status };
};

const ensureActor = async (actor) => {
  const existing = await apiRequest(`/api/actors/by-handle/${actor.handle}`, {
    expectedStatuses: [200, 404],
  });

  if (existing.status === 404) {
    const created = await apiRequest("/api/actors", {
      method: "POST",
      body: actor,
      expectedStatuses: [201],
    });
    return { id: created.payload.id, result: "created" };
  }

  if (existing.payload.type !== actor.type) {
    throw new Error(
      `Actor handle '${actor.handle}' exists with type '${existing.payload.type}', expected '${actor.type}'`,
    );
  }

  return { id: existing.payload.id, result: "reused" };
};

const join = (actorId) =>
  apiRequest(`/api/rooms/${roomId}/presence`, {
    method: "POST",
    body: { actorId, state: "joined" },
    expectedStatuses: [201],
  });

const main = async () => {
  await apiRequest("/health");

  const results = [];
  for (const bot of bots) {
    const { id, result } = await ensureActor(bot);
    await join(id);
    results.push(`${bot.displayName} (${result})`);
  }

  console.log(`Seeded bots into '${roomId}':`);
  for (const line of results) {
    console.log(`  ${line}`);
  }
};

main().catch((error) => {
  console.error(
    error instanceof Error ? `Seed failed: ${error.message}` : error,
  );
  process.exitCode = 1;
});
