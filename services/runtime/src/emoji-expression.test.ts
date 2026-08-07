import assert from "node:assert/strict";
import test from "node:test";

import {
  emojiForMood,
  parseEmojiMood,
  requestedEmojiMood,
} from "./emoji-expression.js";

test("turns a brain-selected mood into a smiley", () => {
  assert.equal(parseEmojiMood('{"mood":"DELIGHTED"}'), "delighted");
  assert.equal(parseEmojiMood("😄"), "delighted");
  assert.equal(emojiForMood("delighted"), "😄");
  assert.equal(requestedEmojiMood("Show that you are delighted."), "delighted");
  assert.equal(requestedEmojiMood("Send any smiley you like."), null);
});

test("rejects unknown emoji moods and accepts PASS", () => {
  assert.equal(parseEmojiMood("PASS"), null);
  assert.equal(parseEmojiMood('{"mood":"confused_about_the_contract"}'), null);
});
