import assert from "node:assert/strict";
import test from "node:test";
import { InferenceError, Mind } from "./mind.js";
import type { Persona } from "./personas.js";

const persona: Persona = {
  handle: "jakob",
  displayName: "Jakob",
  activity: { startHourUtc: 10, endHourUtc: 20 },
  card: "You are curious about whatever people bring into the room.",
};

const roster = {
  residents: ["Arwen", "Jakob"],
  humans: ["Mira"],
  roomTimeUtc: "2026-07-18T12:00:00.000Z",
};

const topicContext = {
  eligible: true,
  questionAllowed: true,
  guidance: "The active topic is rainy bike commutes.",
};

test("returns a model-grounded topic decision", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_input, init) => {
    const requestBody = JSON.parse(
      String(init?.body),
    ) as Record<string, unknown>;
    requestBodies.push(requestBody);
    const content =
      "MOVE=continue|SOURCE=conversation|TOPIC=rainy bike commutes|" +
      "ANGLE=keeping belongings dry|" +
      "GROUNDING=Mira said she cycled through the rain|" +
      "MESSAGE=Getting caught in rain is rough. Did your bag stay dry?";

    return new Response(
      JSON.stringify({ content }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const decision = await new Mind("http://ml.test").consider(
      persona,
      roster,
      ["Mira: I cycled home through the rain."],
      "Mira has talked about cycling before.",
      null,
      topicContext,
    );

    assert.deepEqual(decision, {
      speak: true,
      message: "Getting caught in rain is rough. Did your bag stay dry?",
      topic: "rainy bike commutes",
      topicMove: "continue",
      topicSource: "conversation",
      topicGrounding: "Mira said she cycled through the rain",
      topicContribution: "keeping belongings dry",
    });
    assert.equal(requestBodies.length, 1);
    assert.match(
      JSON.stringify(requestBodies[0]),
      /Cadence for MESSAGE/,
    );
    assert.match(
      JSON.stringify(requestBodies[0]),
      /never write a message in all caps/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not speak when a model decision has no topic grounding", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        content: "MOVE=start|SOURCE=persona|TOPIC=unrelated thought",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  try {
    const decision = await new Mind("http://ml.test").consider(
      persona,
      roster,
      [],
      "My interests are still forming from the room.",
      null,
      topicContext,
    );

    assert.deepEqual(decision, { speak: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("treats a participant-named source as conversation grounding", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    const content =
      "MOVE=start|SOURCE=Mira|TOPIC=rainy bike commutes|" +
      "ANGLE=wet brakes need extra stopping distance|" +
      "GROUNDING=Mira said she cycled through the rain|" +
      "MESSAGE=Wet brakes can make the trip home surprisingly tense.";

    return new Response(
      JSON.stringify({ content }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await new Mind("http://ml.test").consider(
      persona,
      roster,
      ["Mira: I cycled home through the rain."],
      "No established experience yet.",
      null,
      topicContext,
      false,
    );

    assert.equal(result.speak, true);
    assert.equal(result.topicSource, "conversation");
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("instructs human-triggered turns to answer the human first", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_input, init) => {
    const requestBody = JSON.parse(
      String(init?.body),
    ) as Record<string, unknown>;
    requestBodies.push(requestBody);

    return new Response(
      JSON.stringify({
        content:
          "MOVE=reply|SOURCE=conversation|TOPIC=bot age|" +
          "ANGLE=Jakob clarifies that he has no human age|" +
          "GROUNDING=Mira asked Jakob how old he is|" +
          "MESSAGE=I do not have a human age. I have been here long enough to develop standards.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const decision = await new Mind("http://ml.test").consider(
      persona,
      roster,
      ["Mira: How old are you Jakob?"],
      "No established experience yet.",
      "The human Mira just said: How old are you Jakob? They are speaking to you. They asked a direct question, so answer the question first. Reply to them.",
      topicContext,
      false,
    );

    assert.equal(decision.speak, true);
    assert.equal(requestBodies.length, 1);
    assert.match(
      JSON.stringify(requestBodies[0]),
      /first sentence must answer it/,
    );
    assert.match(
      JSON.stringify(requestBodies[0]),
      /Persona can shape the wording after that/,
    );
    assert.match(
      JSON.stringify(requestBodies[0]),
      /cannot replace the answer/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not apply the human-first rule to autonomous turns", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_input, init) => {
    const requestBody = JSON.parse(
      String(init?.body),
    ) as Record<string, unknown>;
    requestBodies.push(requestBody);

    return new Response(
      JSON.stringify({
        content:
          "MOVE=continue|SOURCE=conversation|TOPIC=rainy bike commutes|" +
          "ANGLE=wet brakes need extra stopping distance|" +
          "GROUNDING=Mira said she cycled through the rain|" +
          "MESSAGE=Wet brakes can make the trip home surprisingly tense.",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const decision = await new Mind("http://ml.test").consider(
      persona,
      roster,
      ["Mira: I cycled home through the rain."],
      "No established experience yet.",
      null,
      topicContext,
      false,
    );

    assert.equal(decision.speak, true);
    assert.equal(requestBodies.length, 1);
    assert.doesNotMatch(
      JSON.stringify(requestBodies[0]),
      /first sentence must answer it/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reuses a stable planning prefix and sends only recent transcript", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<{
    system: string;
    messages: Array<{ content: string }>;
  }> = [];

  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)));

    return new Response(
      JSON.stringify({
        content:
          "MESSAGE=Fresh detail.|MOVE=continue|SOURCE=conversation|" +
          "TOPIC=recent detail|ANGLE=fresh detail|" +
          "GROUNDING=the recent conversation",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const transcript = Array.from(
    { length: 12 },
    (_, index) => `Speaker-${index}: message-${index}`,
  );

  try {
    const mind = new Mind("http://ml.test", () => 0.5);
    await mind.consider(
      persona,
      roster,
      transcript,
      "No established experience yet.",
      null,
      topicContext,
      false,
    );
    await mind.consider(
      persona,
      roster,
      transcript,
      "No established experience yet.",
      "The human Mira just said: hello. Reply to them.",
      topicContext,
      false,
    );

    assert.equal(requestBodies.length, 2);
    assert.equal(requestBodies[0]?.system, requestBodies[1]?.system);
    const userContext = requestBodies[0]?.messages[0]?.content ?? "";
    assert.equal(userContext.includes("Speaker-0: message-0\n"), false);
    assert.equal(userContext.includes("Speaker-1: message-1\n"), false);
    assert.match(userContext, /message-2/);
    assert.match(userContext, /message-11/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("surfaces the inference service explanation when generation fails", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: "The hosted model rejected the request.",
      }),
      { status: 502, headers: { "content-type": "application/json" } },
    );

  try {
    await assert.rejects(
      new Mind("http://ml.test").consider(
        persona,
        roster,
        [],
        "No established experience yet.",
        null,
        topicContext,
        false,
      ),
      /HTTP 502: The hosted model rejected the request\./,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preserves structured inference failure codes", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        detail: {
          code: "insufficient_quota",
          message: "OpenAI rejected this project with insufficient_quota.",
          retryAfterMs: 120_000,
        },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );

  try {
    await assert.rejects(
      new Mind("http://ml.test").consider(
        persona,
        roster,
        [],
        "No established experience yet.",
        null,
        topicContext,
        false,
      ),
      (error: unknown) =>
        error instanceof InferenceError &&
        error.status === 503 &&
        error.code === "insufficient_quota" &&
        error.retryAfterMs === 120_000 &&
        /insufficient_quota/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runs only one inference request at a time", async () => {
  const originalFetch = globalThis.fetch;
  let activeRequests = 0;
  let maximumActiveRequests = 0;

  globalThis.fetch = async () => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeRequests -= 1;

    return new Response(JSON.stringify({ content: "EVERYONE" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const mind = new Mind("http://ml.test");

    await Promise.all([
      mind.addressee(["Arwen", "Jakob"], [], "Mira", "Hello"),
      mind.addressee(["Arwen", "Jakob"], [], "Theo", "Good morning"),
    ]);

    assert.equal(maximumActiveRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
