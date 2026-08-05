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

test("retrieves only the freshest lived moments for a turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-experience-"));

  try {
    const experience = await AgentExperience.load(directory, persona);

    for (let index = 0; index < 6; index += 1) {
      experience.perceive({
        speaker: "Mira",
        type: "human",
        content: `distinct lived moment ${index}`,
        occurredAt: `2026-07-18T12:00:0${index}.000Z`,
        addressedToSelf: false,
        addressedToRoom: true,
        fromSelf: false,
      });
    }

    const view = experience.view();
    assert.doesNotMatch(view, /distinct lived moment [01]/);
    assert.match(view, /distinct lived moment 2/);
    assert.match(view, /distinct lived moment 5/);
    await experience.flush();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("learns from an ordinary reply that immediately follows its message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-experience-"));

  try {
    const experience = await AgentExperience.load(directory, persona);
    experience.perceive({
      speaker: "Jakob",
      type: "chat_bot",
      content: "Rainy walks make the city feel quieter.",
      occurredAt: "2026-07-18T12:00:00.000Z",
      addressedToSelf: false,
      addressedToRoom: false,
      fromSelf: true,
    });
    experience.perceive({
      speaker: "Arwen",
      type: "chat_bot",
      content: "They do, especially when the streets are nearly empty.",
      occurredAt: "2026-07-18T12:00:10.000Z",
      addressedToSelf: false,
      addressedToRoom: false,
      followedSelf: true,
      fromSelf: false,
    });

    assert.match(experience.view(), /Exchanges that drew a response/);
    assert.match(experience.view(), /Rainy walks make the city feel quieter/);
    await experience.flush();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
