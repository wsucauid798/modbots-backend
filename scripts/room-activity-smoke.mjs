const apiBaseUrl = process.env.MODBOTS_API_URL ?? "http://localhost:3001";
const realtimeBaseUrl =
  process.env.MODBOTS_REALTIME_URL ?? "ws://localhost:3002";
const roomId = process.env.MODBOTS_ROOM_ID ?? "global-lobby";
const timeoutMilliseconds = 10_000;

const actors = [
  {
    handle: "smoke-human",
    displayName: "Smoke Test Human",
    type: "human",
  },
  {
    handle: "smoke-chat-bot",
    displayName: "Smoke Test Chat Bot",
    type: "chat_bot",
  },
  {
    handle: "smoke-mod-bot",
    displayName: "Smoke Test Mod Bot",
    type: "mod_bot",
  },
];

// Resolves handle -> backend-generated actor id for this run.
const actorIds = new Map();
const idFor = (handle) => {
  const id = actorIds.get(handle);
  if (id === undefined) {
    throw new Error(`Actor handle '${handle}' was not created`);
  }
  return id;
};

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
  { method = "GET", body, headers = {}, expectedStatuses = [200] } = {},
) => {
  const response = await fetch(url, {
    method,
    headers:
      body === undefined
        ? headers
        : { "content-type": "application/json", ...headers },
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
  const existing = await apiRequest(`/api/actors/by-handle/${actor.handle}`, {
    expectedStatuses: [200, 404],
  });

  if (existing.status === 404) {
    const created = await apiRequest("/api/actors", {
      method: "POST",
      body: actor,
      expectedStatuses: [201],
    });
    actorIds.set(actor.handle, created.payload.id);
    return "created";
  }

  if (existing.payload.type !== actor.type) {
    throw new Error(
      `Actor handle '${actor.handle}' exists with type '${existing.payload.type}', expected '${actor.type}'`,
    );
  }

  actorIds.set(actor.handle, existing.payload.id);

  if (existing.payload.retiredAt !== null) {
    await apiRequest(`/api/actors/${existing.payload.id}/restore`, {
      method: "POST",
      expectedStatuses: [200],
    });
    return "restored";
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

const post = async (path, body, expectedStatuses = [201], headers = {}) =>
  (
    await apiRequest(path, {
      method: "POST",
      body,
      headers,
      expectedStatuses,
    })
  ).payload;

const main = async () => {
  const runId = new Date().toISOString().replaceAll(/[^0-9]/g, "");

  await apiRequest("/health");
  await request(realtimeHttpUrl("/health"));

  const actorResults = [];
  for (const actor of actors) {
    actorResults.push({ id: actor.handle, result: await ensureActor(actor) });
  }

  const baselineSequence = await latestRoomSequence();
  const realtime = await openRealtimeCollector(baselineSequence);

  try {
    const expectedEvents = [];

    for (const actor of actors) {
      expectedEvents.push(
        await post(`/api/rooms/${roomId}/presence`, {
          actorId: idFor(actor.handle),
          state: "joined",
        }),
      );
    }

    const humanMessage = await post(`/api/rooms/${roomId}/messages`, {
      actorId: idFor("smoke-human"),
      content: `[smoke:${runId}] Testing room activity and moderation.`,
    });
    expectedEvents.push(humanMessage);

    const botMessage = await post(`/api/rooms/${roomId}/messages`, {
      actorId: idFor("smoke-chat-bot"),
      content: `[smoke:${runId}] Automated response for the activity flow.`,
    });
    expectedEvents.push(botMessage);

    const humanContentItemId = humanMessage.payload?.contentItemId;

    if (typeof humanContentItemId !== "string") {
      throw new Error(
        "The compatibility message event did not carry its content item id",
      );
    }

    const contentPosted = await post(`/api/rooms/${roomId}/content`, {
      actorId: idFor("smoke-human"),
      parts: [{ kind: "text", text: `[smoke:${runId}] Content path check.` }],
      replyTo: { contentItemId: humanContentItemId },
      references: [
        {
          relationshipType: "context",
          target: {
            targetType: "content_item",
            contentItemId: humanContentItemId,
          },
        },
      ],
    });
    expectedEvents.push(contentPosted.event);
    const contentItemId = contentPosted.contentItem.contentItemId;

    const contentEdited = await apiRequest(
      `/api/rooms/${roomId}/content/${contentItemId}`,
      {
        method: "PATCH",
        body: {
          actorId: idFor("smoke-human"),
          parts: [
            {
              kind: "text",
              text: `[smoke:${runId}] Content path check, edited.`,
            },
          ],
        },
        expectedStatuses: [200],
      },
    );
    expectedEvents.push(contentEdited.payload.event);

    const contentRemoved = await post(
      `/api/rooms/${roomId}/content/${contentItemId}/remove`,
      { actorId: idFor("smoke-human") },
      [200],
    );
    expectedEvents.push(contentRemoved.event);

    const rejected = await post(
      `/api/rooms/${roomId}/moderation/proposals`,
      {
        modBotId: idFor("smoke-mod-bot"),
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
        reviewerActorId: idFor("smoke-human"),
        decision: "rejected",
      },
      [200],
    );
    expectedEvents.push(rejectedDecision.event);

    const botContentItemId = botMessage.payload?.contentItemId;

    if (typeof botContentItemId !== "string") {
      throw new Error(
        "The bot message event did not carry its content item id",
      );
    }

    const accepted = await post(
      `/api/rooms/${roomId}/moderation/proposals`,
      {
        modBotId: idFor("smoke-mod-bot"),
        target: {
          targetType: "content_item",
          contentItemId: botContentItemId,
        },
        evidence: [
          {
            target: {
              targetType: "content_item",
              contentItemId: humanContentItemId,
            },
            note: "Earlier context that the reply depends on",
          },
          {
            target: {
              targetType: "content_item",
              contentItemId,
            },
          },
        ],
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
        reviewerActorId: idFor("smoke-human"),
        decision: "accepted",
      },
      [200],
    );
    expectedEvents.push(acceptedDecision.event);

    // Actor moderation: mute the chat bot, prove it cannot post, unmute it,
    // and prove it can post again.
    const mute = await post(`/api/rooms/${roomId}/moderation/proposals`, {
      modBotId: idFor("smoke-mod-bot"),
      target: { targetType: "actor", actorId: idFor("smoke-chat-bot") },
      action: "mute_actor",
      confidence: 0.97,
      rationale: { runId, scenario: "expected-mute" },
      modelVersion: "smoke-v1",
    });
    expectedEvents.push(mute.event);

    const muteDecision = await post(
      `/api/rooms/${roomId}/moderation/proposals/${mute.proposal.id}/decision`,
      { reviewerActorId: idFor("smoke-human"), decision: "accepted" },
      [200],
    );
    expectedEvents.push(muteDecision.event);

    await apiRequest(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: {
        actorId: idFor("smoke-chat-bot"),
        content: `[smoke:${runId}] This must be blocked while muted.`,
      },
      expectedStatuses: [409],
    });

    const unmute = await post(`/api/rooms/${roomId}/moderation/proposals`, {
      modBotId: idFor("smoke-mod-bot"),
      target: { targetType: "actor", actorId: idFor("smoke-chat-bot") },
      action: "unmute_actor",
      confidence: 0.97,
      rationale: { runId, scenario: "expected-unmute" },
      modelVersion: "smoke-v1",
    });
    expectedEvents.push(unmute.event);

    const unmuteDecision = await post(
      `/api/rooms/${roomId}/moderation/proposals/${unmute.proposal.id}/decision`,
      { reviewerActorId: idFor("smoke-human"), decision: "accepted" },
      [200],
    );
    expectedEvents.push(unmuteDecision.event);

    const unmutedMessage = await post(`/api/rooms/${roomId}/messages`, {
      actorId: idFor("smoke-chat-bot"),
      content: `[smoke:${runId}] Posting again after the unmute.`,
    });
    expectedEvents.push(unmutedMessage);

    // A walk-in guest participates and is moderated without registering.
    // Guest creation issues a session, and the guest's writes present its
    // token, proving the bearer session binds to the guest's own actor.
    const guestJoin = (
      await apiRequest("/api/guests", {
        method: "POST",
        body: { acceptPolicy: true },
        expectedStatuses: [201],
      })
    ).payload;
    const guest = guestJoin.actor;

    if (
      guest?.registered !== false ||
      !/^Guest-[0-9]{4,}$/.test(guest?.display)
    ) {
      throw new Error(
        "Guest identity did not render as an unregistered Name-dddd display",
      );
    }

    if (
      typeof guestJoin.session?.token !== "string" ||
      guestJoin.session.token.length === 0
    ) {
      throw new Error("Guest creation did not issue a session token");
    }

    const guestAuth = { authorization: `Bearer ${guestJoin.session.token}` };

    expectedEvents.push(
      await post(
        `/api/rooms/${roomId}/presence`,
        { actorId: guest.id, state: "joined" },
        [201],
        guestAuth,
      ),
    );

    const guestMessage = await post(
      `/api/rooms/${roomId}/messages`,
      {
        actorId: guest.id,
        content: `[smoke:${runId}] Walk-in guest message.`,
      },
      [201],
      guestAuth,
    );
    expectedEvents.push(guestMessage);

    // The session is bound to its actor: the guest token may not act as the
    // smoke human.
    await apiRequest(`/api/rooms/${roomId}/messages`, {
      method: "POST",
      body: {
        actorId: idFor("smoke-human"),
        content: `[smoke:${runId}] This impersonation must be refused.`,
      },
      headers: guestAuth,
      expectedStatuses: [403],
    });

    if (guestMessage.payload?.authorRegistered !== false) {
      throw new Error(
        "The guest message was not labeled with registration status",
      );
    }

    const guestModeration = await post(
      `/api/rooms/${roomId}/moderation/proposals`,
      {
        modBotId: idFor("smoke-mod-bot"),
        target: {
          targetType: "content_item",
          contentItemId: guestMessage.payload.contentItemId,
        },
        action: "delete_message",
        ruleId: "respect",
        confidence: 0.98,
        rationale: { runId, scenario: "guest-moderation" },
        modelVersion: "smoke-v1",
      },
    );
    expectedEvents.push(guestModeration.event);

    if (
      guestModeration.proposal.ruleId !== "respect" ||
      typeof guestModeration.proposal.rulesVersion !== "string" ||
      guestModeration.event.payload?.ruleId !== "respect"
    ) {
      throw new Error(
        "The moderation proposal did not carry its rule citation",
      );
    }

    const guestDecision = await post(
      `/api/rooms/${roomId}/moderation/proposals/${guestModeration.proposal.id}/decision`,
      { reviewerActorId: idFor("smoke-human"), decision: "accepted" },
      [200],
    );
    expectedEvents.push(guestDecision.event);

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
      actorId: idFor("smoke-human"),
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

    const contentList = await apiRequest(
      `/api/rooms/${roomId}/content?after=${baselineSequence}&limit=500`,
    );
    const projected = new Map(
      contentList.payload.data.map((item) => [item.contentItemId, item]),
    );
    const removedItem = projected.get(contentItemId);

    if (
      removedItem?.lifecycleState !== "removed" ||
      removedItem?.revision !== 2
    ) {
      throw new Error(
        "The content projection did not reflect the edit and removal",
      );
    }

    if (!projected.has(humanContentItemId)) {
      throw new Error(
        "The compatibility message did not materialize as a content item",
      );
    }

    if (projected.get(botContentItemId)?.lifecycleState !== "removed") {
      throw new Error(
        "The accepted delete_message action did not remove the target content",
      );
    }

    if (projected.get(humanContentItemId)?.lifecycleState !== "published") {
      throw new Error(
        "The rejected proposal must leave its target content published",
      );
    }

    if (
      projected.get(guestMessage.payload.contentItemId)?.lifecycleState !==
      "removed"
    ) {
      throw new Error("The guest content was not moderated");
    }

    // Leave the room so smoke actors do not linger in the roster. The guest
    // is retired: guest identities are ephemeral and each run creates a new
    // one.
    for (const actor of actors) {
      await post(`/api/rooms/${roomId}/presence`, {
        actorId: idFor(actor.handle),
        state: "left",
      });
    }

    // Logging out revokes the guest session; the revoked token no longer
    // resolves, so a second revoke is refused.
    await apiRequest("/api/sessions/revoke", {
      method: "POST",
      headers: guestAuth,
      expectedStatuses: [204],
    });
    await apiRequest("/api/sessions/revoke", {
      method: "POST",
      headers: guestAuth,
      expectedStatuses: [401],
    });

    await apiRequest(`/api/actors/${guest.id}/retire`, {
      method: "POST",
      expectedStatuses: [200],
    });

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
    console.log("Content projection: verified");
    console.log("Moderation enforcement: verified");
    console.log("Actor moderation: verified");
    console.log("Guest participation: verified");
    console.log("Rule citation: verified");
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
