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

test("moves to a new topic without stopping after three bot turns", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 3; turn += 1) {
    topics.recordBotTurn(
      decision(`distinct contribution ${turn}`, "start"),
      `Distinct statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  assert.equal(topics.turnContext("autonomous", 30_000).eligible, true);
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

  for (let turn = 0; turn < 3; turn += 1) {
    topics.recordBotTurn(
      decision(`new repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  topics.turnContext("autonomous", 30_000);
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

  for (let turn = 0; turn < 3; turn += 1) {
    topics.recordBotTurn(
      decision(`new repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  const context = topics.turnContext("autonomous", 30_000);

  assert.equal(context.eligible, true);
  assert.match(context.guidance, /Recently completed topics: repairing old objects/);
  assert.match(context.guidance, /Choose a clearly different subject/);
});
