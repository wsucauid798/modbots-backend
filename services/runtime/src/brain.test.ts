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
