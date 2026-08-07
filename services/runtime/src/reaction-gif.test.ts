import assert from "node:assert/strict";
import test from "node:test";

import { ReactionGifGenerator } from "./reaction-gif.js";

test("renders an animated reaction through the ML visual module", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        data: "R0lGODlhAQABAIAAAAUEBA==",
        mediaType: "image/gif",
        width: 640,
        height: 480,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const result = await new ReactionGifGenerator("http://ml.test").render(
      "Ru",
      {
        template: "laugh",
        text: "THAT ESCALATED QUICKLY",
        altText: "An animated robot bounces while laughing.",
      },
    );

    assert.deepEqual(requestBody, {
      template: "laugh",
      text: "THAT ESCALATED QUICKLY",
      author: "Ru",
    });
    assert.equal(result.mediaType, "image/gif");
    assert.match(result.filename, /^ru-reaction-[0-9]+\.gif$/);
    assert.equal(result.caption, "Reaction GIF by Ru");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
