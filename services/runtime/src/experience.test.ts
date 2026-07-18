import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentExperience } from "./experience.js";
import type { Persona } from "./personas.js";

const persona: Persona = {
  handle: "jacob",
  displayName: "Jakob",
  activity: { startHourUtc: 10, endHourUtc: 20 },
  card: "Friendly and curious.",
};

test("migrates old experience without guessed topic words", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-experience-"));

  try {
    await writeFile(
      join(directory, "jacob.json"),
      JSON.stringify({
        version: 1,
        handle: "jacob",
        displayName: "Jakob",
        people: {},
        interests: { actually: { weight: 99, lastSeenAt: "2026-01-01" } },
        curiosities: {},
        impressions: ["Arwen talked about actually."],
      }),
      "utf8",
    );

    const experience = await AgentExperience.load(directory, persona);
    const view = experience.view();

    assert.doesNotMatch(view, /actually/);
    assert.doesNotMatch(view, /Topics I have been drawn toward/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("remembers real conversational moments for model interpretation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-experience-"));

  try {
    const experience = await AgentExperience.load(directory, persona);
    experience.perceive({
      speaker: "Mira",
      type: "human",
      content: "I finally repaired the old bicycle my grandfather left me.",
      occurredAt: "2026-07-18T12:00:00.000Z",
      addressedToSelf: true,
      addressedToRoom: false,
      fromSelf: false,
    });
    await experience.flush();

    const view = experience.view();
    assert.match(view, /Mira said to me/);
    assert.match(view, /old bicycle my grandfather left me/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
