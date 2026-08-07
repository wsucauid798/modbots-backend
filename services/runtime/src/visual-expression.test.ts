import assert from "node:assert/strict";
import test from "node:test";

import { parseVisualIdea } from "./visual-expression.js";

test("parses meme and animated GIF expression ideas", () => {
  assert.deepEqual(
    parseVisualIdea(
      '{"kind":"meme","template":"contrast","topText":"Before tests","bottomText":"After tests","altText":"A before and after testing joke."}',
    ),
    {
      kind: "meme",
      template: "contrast",
      topText: "Before tests",
      bottomText: "After tests",
      altText: "A before and after testing joke.",
    },
  );
  assert.deepEqual(
    parseVisualIdea(
      '{"kind":"GIF","template":"SIDE_EYE","text":"A TINY CHANGE?","altText":"An animated robot gives a suspicious side-eye."}',
    ),
    {
      kind: "gif",
      template: "side_eye",
      text: "A TINY CHANGE?",
      altText: "An animated robot gives a suspicious side-eye.",
    },
  );
  assert.deepEqual(
    parseVisualIdea(
      '{"kind":"facepalm","template":"facepalm","text":"TINY CHANGE! \\u2014 EVERYTHING BREAKS","altText":"An animated robot performs a facepalm."}',
    ),
    {
      kind: "gif",
      template: "facepalm",
      text: "TINY CHANGE!, EVERYTHING BREAKS",
      altText: "An animated robot performs a facepalm.",
    },
  );
});

test("rejects malformed visual ideas and accepts PASS", () => {
  assert.equal(parseVisualIdea("PASS"), null);
  assert.equal(parseVisualIdea('{"kind":"gif","template":"unknown"}'), null);
  assert.equal(parseVisualIdea("not json"), null);
});
