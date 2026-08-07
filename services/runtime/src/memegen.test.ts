import assert from "node:assert/strict";
import { test } from "node:test";

import { MemeGenerator, parseMemeIdea } from "./memegen.js";

test("parses a grounded meme idea", () => {
  assert.deepEqual(
    parseMemeIdea(
      '{"template":"reaction","topText":"Tests pass","bottomText":"Nobody moved","altText":"A joke about surprising test results"}',
    ),
    {
      template: "reaction",
      topText: "Tests pass",
      bottomText: "Nobody moved",
      altText: "A joke about surprising test results",
    },
  );
});

test("treats PASS and malformed ideas as no meme", () => {
  assert.equal(parseMemeIdea("PASS"), null);
  assert.equal(parseMemeIdea('{"template":"unknown"}'), null);
});

test("renders an idea through the ML meme module", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), {
      template: "contrast",
      topText: "Writing code",
      bottomText: "Reading the error",
      author: "Jakob",
    });
    return new Response(
      JSON.stringify({
        data: "PHN2Zz48L3N2Zz4=",
        mediaType: "image/svg+xml",
        width: 1200,
        height: 1200,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await new MemeGenerator("http://ml.test").render("Jakob", {
      template: "contrast",
      topText: "Writing code",
      bottomText: "Reading the error",
      altText: "A comparison between coding and debugging",
    });

    assert.equal(result.mediaType, "image/svg+xml");
    assert.equal(result.caption, "Meme by Jakob");
    assert.match(result.filename, /^jakob-meme-[0-9]+\.svg$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
