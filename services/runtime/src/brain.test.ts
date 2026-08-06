import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BotBrain } from "./brain.js";
import { personas } from "./personas.js";

test("constructs one durable brain for each of the eight canonical bots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-brains-"));

  try {
    const brains = await Promise.all(
      personas.map((persona) =>
        BotBrain.load(directory, persona, "http://ml.test"),
      ),
    );

    assert.equal(brains.length, 8);
    assert.equal(new Set(brains).size, 8);
    assert.equal(new Set(brains.map((brain) => brain.persona.handle)).size, 8);
    assert.equal(
      brains.filter((brain) => brain.persona.type === "chat_bot").length,
      5,
    );
    assert.equal(
      brains.filter((brain) => brain.persona.type === "mod_bot").length,
      3,
    );
    assert.equal(
      brains.filter(
        (brain) =>
          brain.persona.type === "chat_bot" &&
          !("workShift" in brain.persona),
      ).length,
      5,
    );
    assert.equal(
      brains.filter(
        (brain) =>
          brain.persona.type === "mod_bot" &&
          "workShift" in brain.persona,
      ).length,
      3,
    );

    for (const brain of brains) {
      brain.perceive({
        speaker: brain.persona.displayName,
        type: brain.persona.type,
        content: `I am ${brain.persona.displayName}.`,
        occurredAt: "2026-08-07T00:00:00.000Z",
        fromSelf: true,
        addressedToSelf: false,
        addressedToRoom: false,
        followedSelf: false,
      });
      await brain.flush();
    }

    const files = (await readdir(directory)).sort();
    assert.deepEqual(
      files,
      personas.map((persona) => `${persona.handle}.json`).sort(),
    );

    for (const persona of personas) {
      const state = JSON.parse(
        await readFile(join(directory, `${persona.handle}.json`), "utf8"),
      ) as { handle: string; displayName: string };
      assert.equal(state.handle, persona.handle);
      assert.equal(state.displayName, persona.displayName);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("gives mod bot brains a moderation learning direction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-brains-"));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        content:
          "TOPIC=Context in moderation\n" +
          "KNOWLEDGE=Context changes how behavior should be interpreted. " +
          "Fair interventions consider patterns and impact.\n" +
          "WHY=Context reduces incorrect and biased interventions.\n" +
          "CURIOSITY=Which context signals most improve fair decisions?",
        sources: [
          {
            title: "Community moderation research",
            url: "https://example.com/moderation",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const vera = personas.find((persona) => persona.handle === "vera");
    assert.notEqual(vera, undefined);
    const brain = await BotBrain.load(
      directory,
      vera as (typeof personas)[number],
      "http://ml.test",
    );
    const result = await brain.research(
      [],
      "2026-08-07T00:00:00.000Z",
    );
    const serialized = JSON.stringify(requestBody);

    assert.equal(result.direction.kind, "public_subject");
    assert.match(result.direction.focus, /community safety/);
    assert.match(serialized, /learning inside a mod bot/);
    assert.match(serialized, /fair intervention/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("researches current news without sending private room text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-brains-"));
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        content:
          "TOPIC=Current public news\n" +
          "KNOWLEDGE=Several major public events were reported today. " +
          "The details were confirmed by current sources.\n" +
          "WHY=People asked what is happening today.\n" +
          "CURIOSITY=Which report matters most to the conversation?",
        sources: [
          {
            title: "Public news source",
            url: "https://example.com/news",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const arwen = personas.find((persona) => persona.handle === "arwen");
    assert.notEqual(arwen, undefined);
    const brain = await BotBrain.load(
      directory,
      arwen as (typeof personas)[number],
      "http://ml.test",
    );
    brain.perceive({
      speaker: "Mina",
      type: "human",
      content: "My private account number is 12345.",
      occurredAt: "2026-08-07T00:00:00.000Z",
      fromSelf: false,
      addressedToSelf: false,
      addressedToRoom: true,
      followedSelf: false,
    });

    const result = await brain.researchForParticipant(
      "Major public news headlines reported today",
      "2026-08-07T00:01:00.000Z",
    );
    const serialized = JSON.stringify(requestBody);

    assert.equal(result.direction.kind, "participant_subject");
    assert.match(serialized, /Major public news headlines reported today/);
    assert.doesNotMatch(serialized, /private account number|12345/);
    assert.match(serialized, /No participant messages, identities/);
    await brain.flush();
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("puts freshly researched news into the answering brain", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-brains-"));
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];

  globalThis.fetch = async (_input, init) => {
    requestBodies.push(String(init?.body));
    const content = requestBodies.length === 1
      ? "MOVE=reply|SOURCE=knowledge|TOPIC=current public news|ANGLE=answer headlines|GROUNDING=current sourced knowledge"
      : "Several major public events were reported today.";
    return new Response(JSON.stringify({ content }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const arwen = personas.find((persona) => persona.handle === "arwen");
    assert.notEqual(arwen, undefined);
    const brain = await BotBrain.load(
      directory,
      arwen as (typeof personas)[number],
      "http://ml.test",
    );
    const knowledge = {
      topic: "current public news",
      statement: "Several major public events were reported today.",
      confidence: 0.8,
      sources: [{ title: "Public news", url: "https://example.com/news" }],
    };

    const decision = await brain.consider(
      {
        residents: ["Arwen"],
        humans: ["Mina"],
        roomTimeUtc: "2026-08-07T00:01:00.000Z",
      },
      ["Mina: What's the latest news today?"],
      "The human Mina asked for today's news. Answer the question first.",
      {
        eligible: true,
        questionAllowed: true,
        activeTopic: null,
        botTurnsOnTopic: 0,
        guidance: "Ground the reply in the human's question.",
      },
      false,
      undefined,
      knowledge,
    );
    const serialized = requestBodies.join("\n");

    assert.equal(decision.speak, true);
    assert.match(serialized, /Current sourced knowledge retrieved/);
    assert.match(serialized, /Several major public events/);
    assert.match(serialized, /do not claim that you lack access/);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
