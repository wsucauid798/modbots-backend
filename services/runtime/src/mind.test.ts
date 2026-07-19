import assert from "node:assert/strict";
import test from "node:test";
import { Mind } from "./mind.js";
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
  trigger: "human" as const,
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
      requestBodies.length === 1
        ? "MOVE=continue|SOURCE=conversation|TOPIC=rainy bike commutes|ANGLE=keeping belongings dry|GROUNDING=Mira said she cycled through the rain"
        : "Getting caught in rain is rough. Did your bag stay dry?";

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
    assert.equal(requestBodies.length, 2);
    assert.match(
      JSON.stringify(requestBodies[1]),
      /Chosen topic: rainy bike commutes/,
    );
    assert.match(
      JSON.stringify(requestBodies[1]),
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

test("plans and writes an autonomous turn with one inference request", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Record<string, unknown>[] = [];

  globalThis.fetch = async (_input, init) => {
    requestBodies.push(
      JSON.parse(String(init?.body)) as Record<string, unknown>,
    );

    return new Response(
      JSON.stringify({
        content:
          "MOVE=start|SOURCE=persona|TOPIC=rainy day routines|ANGLE=tea as a slow ritual|GROUNDING=Jakob's established character inclination|MESSAGE=Rain makes a strong cup of tea feel less like a drink and more like a schedule.",
        usage: { inputTokens: 400, cachedInputTokens: 0, outputTokens: 45 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const decision = await new Mind("http://ml.test").consider(
      persona,
      { ...roster, humans: [] },
      ["Arwen: The rain has not stopped all afternoon."],
      "Rainy afternoons tend to make the room quieter.",
      null,
      {
        eligible: true,
        questionAllowed: true,
        guidance: "There is no active topic.",
        trigger: "autonomous",
      },
    );

    assert.equal(requestBodies.length, 1);
    assert.equal(decision.speak, true);
    assert.equal(decision.topic, "rainy day routines");
    assert.equal(decision.topicContribution, "tea as a slow ritual");
    assert.equal(
      decision.message,
      "Rain makes a strong cup of tea feel less like a drink and more like a schedule.",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
