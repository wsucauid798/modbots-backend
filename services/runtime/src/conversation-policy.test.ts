import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConversationPolicy } from "./conversation-policy.js";

test("chooses a direct answer for a human question", () => {
  const policy = ConversationPolicy.inMemory(() => 0);

  assert.equal(policy.chooseDirection({
    trigger: "human",
    activeTopic: null,
    questionAllowed: true,
    directQuestion: true,
  }).intent, "answer_human");
});

test("learns away from conversation actions that confuse humans", () => {
  const policy = ConversationPolicy.inMemory(() => 0);
  let now = 1_000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    policy.recordTurn("Arwen", "start_question", "clock collections", now);
    now += 1_000;
    policy.observeHumanMessage("That is irrelevant and confusing.", now, "Arwen");
    now += 1_000;
  }

  const direction = policy.chooseDirection({
    trigger: "autonomous",
    activeTopic: null,
    questionAllowed: true,
  });

  assert.notEqual(direction.intent, "start_question");
  assert.match(direction.learnedGuidance, /extra clarity around: clock collections/i);
});

test("human responses carry more learning weight than bot continuation", () => {
  const policy = ConversationPolicy.inMemory(() => 0);
  policy.recordTurn("Arwen", "start_opinion", "rainy walks", 1_000);
  policy.recordTurn("Jakob", "respond_topic", "rainy walks", 2_000);
  policy.observeHumanMessage("I love rainy walks too.", 3_000, "Arwen");

  const direction = policy.chooseDirection({
    trigger: "autonomous",
    activeTopic: null,
    questionAllowed: true,
  });

  assert.equal(direction.intent, "start_opinion");
  assert.match(direction.learnedGuidance, /rainy walks/i);
});

test("speaker selection preserves room fairness", () => {
  const policy = ConversationPolicy.inMemory(() => 0);
  const selected = policy.chooseSpeaker([
    { displayName: "Arwen", lastAttemptedAt: 0, lastSpokeAt: 0 },
    { displayName: "Jakob", lastAttemptedAt: 590_000, lastSpokeAt: 590_000 },
  ], 600_000);

  assert.equal(selected?.displayName, "Arwen");
});

test("does not abandon a new topic before another resident responds", () => {
  const policy = ConversationPolicy.inMemory(() => 0);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    policy.recordRejected("respond_topic");
    policy.recordRejected("react_topic");
    policy.recordRejected("ask_follow_up");
  }

  const firstResponse = policy.chooseDirection({
    trigger: "autonomous",
    activeTopic: "cast iron pans",
    questionAllowed: true,
    botTurnsOnTopic: 1,
  });
  const establishedTopic = policy.chooseDirection({
    trigger: "autonomous",
    activeTopic: "cast iron pans",
    questionAllowed: true,
    botTurnsOnTopic: 2,
  });

  assert.notEqual(firstResponse.intent, "wait");
  assert.equal(establishedTopic.intent, "wait");
});

test("persists learned conversation outcomes across runtime restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "modbots-policy-"));

  try {
    const first = await ConversationPolicy.load(directory, () => 0);
    first.recordTurn("Arwen", "start_question", "unclear clocks", 1_000);
    first.observeHumanMessage("That makes no sense.", 2_000, "Arwen");
    await first.flush();

    const reloaded = await ConversationPolicy.load(directory, () => 0);
    const direction = reloaded.chooseDirection({
      trigger: "autonomous",
      activeTopic: null,
      questionAllowed: true,
    });

    assert.notEqual(direction.intent, "start_question");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
