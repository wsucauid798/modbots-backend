import assert from "node:assert/strict";
import test from "node:test";

import type { Decision } from "./mind.js";
import { TopicCoordinator } from "./topic-coordinator.js";

const learnedKnowledge = {
  topic: "repairing old objects",
  statement: "Repair can preserve useful objects and their history.",
  confidence: 0.8,
  curiosity: "When is repair better than replacement?",
  sources: [{ title: "Repair", url: "https://example.com/repair" }],
};

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

  assert.equal(
    topics.turnContext("autonomous", 1_001, learnedKnowledge).eligible,
    true,
  );
  assert.equal(topics.turnContext("human", 1_001).eligible, true);
});

test("a passed turn does not stop an idle room", () => {
  const topics = new TopicCoordinator();

  topics.recordPass(5, 1_000);

  assert.equal(
    topics.turnContext("autonomous", 1_001, learnedKnowledge).eligible,
    true,
  );
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
  assert.match(context.guidance, /Keep TOPIC exactly/);
  assert.doesNotMatch(context.guidance, /Recently completed topics/);
});

test("rejects an associative topic change during an autonomous subject", () => {
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
  assert.equal(evaluated.reason, "active topic attempted an associative change");
});

test("ends an autonomous subject cleanly after three bot turns", () => {
  const topics = new TopicCoordinator();

  for (let turn = 0; turn < 3; turn += 1) {
    topics.recordBotTurn(
      decision(`distinct repair angle ${turn}`, turn === 0 ? "start" : "continue"),
      `Distinct repair statement ${turn}.`,
      "autonomous",
      turn * 10_000,
    );
  }

  const context = topics.turnContext("autonomous", 30_000, learnedKnowledge);

  assert.match(context.guidance, /There is no active topic/);
  assert.match(context.guidance, /Recently completed topics: repairing old objects/);
  assert.doesNotMatch(context.guidance, /bridge/);
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
  assert.match(
    topics.turnContext("human", 3_000).guidance,
    /There is no active topic/,
  );
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
  assert.equal(
    topics.turnContext("autonomous", 17_000, learnedKnowledge).eligible,
    true,
  );
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
  const restartDecision = {
    ...decision("another repair angle", "start"),
    topicSource: "knowledge" as const,
  };
  const restart = topics.evaluate(
    restartDecision,
    "Here is another thought about repairing old objects.",
    "autonomous",
    150_000,
    topics.turnContext("autonomous", 150_000, learnedKnowledge),
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

  const context = topics.turnContext("autonomous", 30_000, learnedKnowledge);

  assert.equal(context.eligible, true);
  assert.match(context.guidance, /Recently completed topics: repairing old objects/);
  assert.match(context.guidance, /Do not rename, revisit, or choose a close variation/);
  assert.doesNotMatch(context.guidance, /https:\/\//);
  assert.match(context.guidance, /Do not mention, cite, or link/);
});

test("requires the active topic label to remain exact", () => {
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

  const renamed = {
    ...decision("using mulch to retain water", "continue"),
    topic: "summer watering",
  };

  const evaluated = topics.evaluate(
    renamed,
    "Mulch keeps the summer watering from evaporating as quickly.",
    "autonomous",
    2_000,
  );

  assert.equal(evaluated.accepted, false);
  assert.equal(evaluated.reason, "active topic label changed");
});

test("requires a fresh autonomous topic to use learned knowledge", () => {
  const topics = new TopicCoordinator();
  const fromConversation = {
    ...decision("turning repair into a breakfast analogy", "start"),
    topic: "breakfast fruit",
  };

  assert.deepEqual(
    topics.evaluate(
      fromConversation,
      "Pears are better at breakfast.",
      "autonomous",
      1_000,
    ),
    {
      accepted: false,
      reason: "new topic did not come from the bot's learned knowledge",
    },
  );

  const independentlyGrounded = {
    ...fromConversation,
    topicSource: "knowledge" as const,
    topicGrounding: "sourced knowledge in the bot brain",
  };

  assert.deepEqual(
    topics.evaluate(
      independentlyGrounded,
      "Pears are better at breakfast.",
      "autonomous",
      1_000,
      topics.turnContext("autonomous", 1_000, {
        ...learnedKnowledge,
        topic: "breakfast fruit",
      }),
    ),
    { accepted: true, message: "Pears are better at breakfast." },
  );
});

test("a direct human reply does not become an autonomous bot topic", () => {
  const topics = new TopicCoordinator();

  topics.recordBotTurn(
    decision("answering the human directly", "reply"),
    "Yes, I am here.",
    "human",
    1_000,
  );

  const context = topics.turnContext("autonomous", 2_000);
  assert.equal(context.eligible, false);
  assert.match(context.guidance, /no learned subject available/i);
});
