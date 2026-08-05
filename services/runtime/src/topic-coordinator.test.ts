import assert from "node:assert/strict";
import test from "node:test";

import type { Decision } from "./mind.js";
import { TopicCoordinator } from "./topic-coordinator.js";

const decision = (
  contribution: string,
  move: NonNullable<Decision["topicMove"]> = "continue",
): Decision => ({
  speak: true,
  message: contribution,
  topic: "repairing old objects",
  topicMove: move,
  topicSource: "conversation",
  topicGrounding: "the current discussion about repairing an old object",
  topicContribution: contribution,
});

test("allows scheduled autonomous speech after loading history", () => {
  const topics = new TopicCoordinator();
  topics.observeHistoricalMessage("chat_bot", 1_000);

  assert.equal(topics.turnContext("autonomous", 1_001).eligible, true);
  assert.equal(topics.turnContext("human", 1_001).eligible, true);
});

test("a passed turn does not stop an idle room", () => {
  const topics = new TopicCoordinator();

  topics.recordPass(5, 1_000);

  assert.equal(topics.turnContext("autonomous", 1_001).eligible, true);
});

test("keeps a topic active after one bot turn", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 1; turn += 1) {
    topics.recordBotTurn(
      decision(`distinct contribution ${turn}`, "start"),
      `Distinct statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  const context = topics.turnContext("autonomous", 10_000);

  assert.equal(context.eligible, true);
  assert.match(context.guidance, /Stay with the subject for now/);
  assert.doesNotMatch(context.guidance, /Recently completed topics/);
});

test("rejects an autonomous topic change before the discussion develops", () => {
  const topics = new TopicCoordinator();
  topics.recordBotTurn(
    decision("repairing the loose handle", "start"),
    "The loose handle can be repaired.",
    "autonomous",
    1_000,
  );

  const change = {
    ...decision("the best fruit for breakfast", "change"),
    topic: "breakfast fruit",
    topicGrounding: "a sudden personal preference",
  };
  const evaluated = topics.evaluate(
    change,
    "Pears are better at breakfast.",
    "autonomous",
    2_000,
  );

  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.reason, "topic changed before it developed");
});

test("invites a conversational bridge after a topic has developed", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 4; turn += 1) {
    topics.recordBotTurn(
      decision(`distinct repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Distinct repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  const context = topics.turnContext("autonomous", 40_000);

  assert.match(context.guidance, /Let this subject end/);
  assert.match(context.guidance, /conversational bridge/);
});

test("allows only one bot question until a human contributes", () => {
  const topics = new TopicCoordinator();
  const first = decision("whether a visible repair tells the object's history", "start");

  topics.recordBotTurn(
    first,
    "Would a visible repair tell its history?",
    "autonomous",
    1_000,
  );

  const second = decision("reversible repairs preserve future choices");
  const evaluated = topics.evaluate(
    second,
    "Reversible repairs preserve future choices. Would you choose one?",
    "autonomous",
    2_000,
  );

  assert.deepEqual(evaluated, {
    accepted: true,
    message: "Reversible repairs preserve future choices.",
  });
  assert.equal(topics.turnContext("autonomous", 2_000).questionAllowed, false);

  topics.noteHumanMessage(3_000);

  assert.equal(topics.turnContext("human", 3_000).questionAllowed, true);
});

test("yields autonomous conversation after a human speaks", () => {
  const topics = new TopicCoordinator();
  topics.recordBotTurn(
    decision("checking whether the skillet sits flat", "start"),
    "Check whether the skillet sits flat.",
    "autonomous",
    1_000,
  );

  topics.noteHumanMessage(2_000);

  assert.equal(topics.turnContext("autonomous", 16_999).eligible, false);
  assert.equal(topics.turnContext("human", 2_001).eligible, true);
  assert.equal(topics.turnContext("autonomous", 17_000).eligible, true);
});

test("rejects a repeated angle on the active topic", () => {
  const topics = new TopicCoordinator();
  topics.recordBotTurn(
    decision("visible repairs preserve an object's history", "start"),
    "A visible repair preserves the object's history.",
    "autonomous",
    1_000,
  );

  const result = topics.evaluate(
    decision("visible repair preserves the history of an object"),
    "Visible repairs can preserve the history of an object.",
    "autonomous",
    2_000,
  );

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "topic angle already covered");
});

test("keeps a closed topic on cooldown", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 5; turn += 1) {
    topics.recordBotTurn(
      decision(`new repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  topics.turnContext("autonomous", 50_000);
  const restart = topics.evaluate(
    decision("another repair angle", "start"),
    "Here is another thought about repairing old objects.",
    "autonomous",
    150_000,
  );

  assert.equal(restart.accepted, false);
  assert.equal(restart.reason, "topic is still on cooldown");
});

test("tells the next speaker which recently completed topics to avoid", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 5; turn += 1) {
    topics.recordBotTurn(
      decision(`new repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  const context = topics.turnContext("autonomous", 50_000);

  assert.equal(context.eligible, true);
  assert.match(context.guidance, /Recently completed topics: repairing old objects/);
  assert.match(context.guidance, /Do not rename, revisit, or choose a close variation/);
});

test("treats related labels as one continuing subject", () => {
  const topics = new TopicCoordinator();
  const initial = {
    ...decision("watering before the heat", "start"),
    topic: "garden watering",
  };
  topics.recordBotTurn(
    initial,
    "Morning watering avoids the worst heat.",
    "autonomous",
    1_000,
  );

  const related = {
    ...decision("using mulch to retain water", "change"),
    topic: "summer watering",
  };

  topics.recordBotTurn(
    related,
    "Mulch keeps the summer watering from evaporating as quickly.",
    "autonomous",
    2_000,
  );

  const context = topics.turnContext("autonomous", 3_000);
  assert.match(context.guidance, /active topic is garden watering/);
  assert.doesNotMatch(context.guidance, /Recently completed topics/);
});
