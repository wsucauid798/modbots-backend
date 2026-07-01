const apiBaseUrl = process.env.MODBOTS_API_URL ?? "http://localhost:3001";
const realtimeBaseUrl =
  process.env.MODBOTS_REALTIME_URL ?? "ws://localhost:3002";
const roomId = process.env.MODBOTS_ROOM_ID ?? "global-lobby";
const timeoutMilliseconds = 10_000;

const actors = [
  {
    id: "smoke-human",
    displayName: "Smoke Test Human",
    type: "human",
  },
  {
    id: "smoke-chat-bot",
    displayName: "Smoke Test Chat Bot",
    type: "chat_bot",
  },
  {
    id: "smoke-mod-bot",
    displayName: "Smoke Test Mod Bot",
    type: "mod_bot",
  },
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const asJson = (raw) => {
  if (raw.length === 0) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Server returned a response that was not valid JSON");
  }
};

const request = async (
  url,
  { method = "GET", body, expectedStatuses = [200] } = {},
) => {
  const response = await fetch(url, {
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

    throw new Error(
      `${method} ${url} returned HTTP ${response.status}${detail}`,
    );
  }

  return { payload, status: response.status };
};

const apiRequest = (path, options) =>
  request(new URL(path, apiBaseUrl).toString(), options);

const realtimeHttpUrl = (path) => {
  const url = new URL(path, realtimeBaseUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
};

const ensureActor = async (actor) => {
  const existing = await apiRequest(`/api/actors/${actor.id}`, {
    expectedStatuses: [200, 404],
  });

  if (existing.status === 404) {
    await apiRequest("/api/actors", {
      method: "POST",
      body: actor,
      expectedStatuses: [201],
    });
    return "created";
  }

  if (existing.payload.type !== actor.type) {
    throw new Error(
      `Actor '${actor.id}' exists with type '${existing.payload.type}', expected '${actor.type}'`,
    );
  }

  return "reused";
};

const listEventsAfter = async (startingSequence) => {
  const events = [];
  let cursor = String(startingSequence);

  while (true) {
    const page = await apiRequest(
      `/api/rooms/${roomId}/events?after=${cursor}&limit=500`,
    );

    if (!Array.isArray(page.payload.data)) {
      throw new Error("Room events response did not contain a data array");
    }

    events.push(...page.payload.data);

    if (
      page.payload.data.length < 500 ||
      page.payload.nextCursor === cursor
    ) {
      return events;
    }

    cursor = page.payload.nextCursor;
  }
};

const latestRoomSequence = async () => {
  const events = await listEventsAfter("0");
  return events.at(-1)?.sequence ?? "0";
};

const openRealtimeCollector = async (after) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("This smoke flow requires Node.js 22 or newer");
  }

  const url = new URL(`/v1/rooms/${roomId}`, realtimeBaseUrl);
  url.searchParams.set("after", after);
  const socket = new WebSocket(url);
  const envelopes = [];
  let messageError;

  socket.addEventListener("message", (message) => {
    try {
      envelopes.push(JSON.parse(String(message.data)));
    } catch (error) {
      messageError =
        error instanceof Error ? error : new Error("Invalid realtime message");
    }
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out connecting to ${url.toString()}`));
    }, timeoutMilliseconds);

    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error(`Could not connect to ${url.toString()}`));
      },
      { once: true },
    );
  });

  return {
    close: () => socket.close(1000, "Smoke flow complete"),
    envelopes,
    send: (envelope) => socket.send(JSON.stringify(envelope)),
    throwIfInvalid: () => {
      if (messageError !== undefined) {
        throw messageError;
      }
    },
  };
};

const waitFor = async (collector, predicate, description) => {
  const deadline = Date.now() + timeoutMilliseconds;

  while (Date.now() < deadline) {
    collector.throwIfInvalid();

    if (predicate(collector.envelopes)) {
      return;
    }

    await sleep(25);
  }

  throw new Error(`Timed out waiting for ${description}`);
};

const post = async (path, body, expectedStatuses = [201]) =>
  (
    await apiRequest(path, {
      method: "POST",
      body,
      expectedStatuses,
    })
  ).payload;

const main = async () => {
  const runId = new Date().toISOString().replaceAll(/[^0-9]/g, "");

  await apiRequest("/health");
  await request(realtimeHttpUrl("/health"));

  const actorResults = [];
  for (const actor of actors) {
    actorResults.push({ id: actor.id, result: await ensureActor(actor) });
  }

  const baselineSequence = await latestRoomSequence();
  const realtime = await openRealtimeCollector(baselineSequence);

  try {
    const expectedEvents = [];

    for (const actor of actors) {
      expectedEvents.push(
        await post(`/api/rooms/${roomId}/presence`, {
          actorId: actor.id,
          state: "joined",
        }),
      );
    }

    const humanMessage = await post(`/api/rooms/${roomId}/messages`, {
      actorId: "smoke-human",
      content: `[smoke:${runId}] Testing room activity and moderation.`,
    });
    expectedEvents.push(humanMessage);

    const botMessage = await post(`/api/rooms/${roomId}/messages`, {
      actorId: "smoke-chat-bot",
      content: `[smoke:${runId}] Automated response for the activity flow.`,
    });
    expectedEvents.push(botMessage);

    const rejected = await post(
      `/api/rooms/${roomId}/moderation/proposals`,
      {
        modBotId: "smoke-mod-bot",
        targetEventSequence: humanMessage.sequence,
        action: "delete_message",
        confidence: 0.55,
        rationale: { runId, scenario: "expected-rejection" },
        modelVersion: "smoke-v1",
      },
    );
    expectedEvents.push(rejected.event);

    const rejectedDecision = await post(
      `/api/rooms/${roomId}/moderation/proposals/${rejected.proposal.id}/decision`,
      {
        reviewerActorId: "smoke-human",
        decision: "rejected",
      },
      [200],
    );
    expectedEvents.push(rejectedDecision.event);

    const accepted = await post(
      `/api/rooms/${roomId}/moderation/proposals`,
      {
        modBotId: "smoke-mod-bot",
        targetEventSequence: botMessage.sequence,
        action: "delete_message",
        confidence: 0.99,
        rationale: { runId, scenario: "expected-acceptance" },
        modelVersion: "smoke-v1",
      },
    );
    expectedEvents.push(accepted.event);

    const acceptedDecision = await post(
      `/api/rooms/${roomId}/moderation/proposals/${accepted.proposal.id}/decision`,
      {
        reviewerActorId: "smoke-human",
        decision: "accepted",
      },
      [200],
    );
    expectedEvents.push(acceptedDecision.event);

    const expectedSequences = new Set(
      expectedEvents.map((event) => event.sequence),
    );

    await waitFor(
      realtime,
      (envelopes) => {
        const receivedSequences = new Set(
          envelopes
            .filter(
              (envelope) =>
                envelope.delivery === "reliable" &&
                envelope.channel === "room.event",
            )
            .map((envelope) => envelope.sequence),
        );

        return [...expectedSequences].every((sequence) =>
          receivedSequences.has(sequence),
        );
      },
      "all authoritative events on the realtime gateway",
    );

    const nonce = `smoke-${runId}`;
    realtime.send({
      version: 1,
      delivery: "ephemeral",
      channel: "latency.ping",
      roomId,
      actorId: "smoke-human",
      sentAt: new Date().toISOString(),
      payload: { nonce },
    });

    await waitFor(
      realtime,
      (envelopes) =>
        envelopes.some(
          (envelope) =>
            envelope.delivery === "ephemeral" &&
            envelope.channel === "latency.ping" &&
            envelope.payload?.nonce === nonce,
        ),
      "the ephemeral realtime echo",
    );

    const persistedEvents = await listEventsAfter(baselineSequence);
    const persistedSequences = new Set(
      persistedEvents.map((event) => event.sequence),
    );

    if (
      ![...expectedSequences].every((sequence) =>
        persistedSequences.has(sequence),
      )
    ) {
      throw new Error("The room event API did not return every emitted event");
    }

    const overview = (
      await apiRequest(`/api/rooms/${roomId}/overview`)
    ).payload;

    if (
      overview.room?.actorsOnline < 3 ||
      overview.room?.chatBotsOnline < 1 ||
      overview.room?.modBotsOnline < 1 ||
      overview.moderation?.proposalsAccepted < 1 ||
      overview.moderation?.proposalsRejected < 1
    ) {
      throw new Error("The derived room overview did not reflect the smoke flow");
    }

    const eventTypes = expectedEvents.map((event) => event.type);
    console.log(`Room activity smoke flow passed for '${roomId}'.`);
    console.log(`Run: ${runId}`);
    console.log(
      `Actors: ${actorResults.map(({ id, result }) => `${id} (${result})`).join(", ")}`,
    );
    console.log(
      `Events: ${expectedEvents.length} authoritative, 1 ephemeral`,
    );
    console.log(`Sequences: ${[...expectedSequences].join(", ")}`);
    console.log(`Types: ${eventTypes.join(", ")}`);
    console.log("Persistence: verified");
    console.log("Derived room state: verified");
    console.log("Realtime delivery: verified");
  } finally {
    realtime.close();
  }
};

main().catch((error) => {
  console.error(
    error instanceof Error ? `Smoke flow failed: ${error.message}` : error,
  );
  process.exitCode = 1;
});
