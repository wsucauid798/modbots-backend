import assert from "node:assert/strict";
import test from "node:test";
import { PlatformClient } from "./platform.js";

test("renames an existing resident without replacing its actor identity", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; method: string; body: string | null }> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const actor = {
      id: "bot-jakob",
      handle: "jacob",
      displayName: method === "PATCH" ? "Jakob" : "Jakob-old",
      display: method === "PATCH" ? "Jakob" : "Jakob-old",
      profilePictureId: null,
      profilePictureUrl: null,
      type: "chat_bot",
      retiredAt: null,
    };

    return new Response(JSON.stringify(actor), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const actor = await new PlatformClient(
      "http://api.test",
      "global-lobby",
    ).ensureActor("jacob", "Jakob", "chat_bot");

    assert.equal(actor.id, "bot-jakob");
    assert.equal(actor.displayName, "Jakob");
    assert.equal(requests.length, 2);
    assert.match(requests[0]!.url, /actors\/by-handle\/jacob$/);
    assert.equal(requests[1]!.method, "PATCH");
    assert.equal(requests[1]!.body, JSON.stringify({ displayName: "Jakob" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("uploads and posts a generated meme through normal room content", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ url: String(input), body });

    if (String(input).endsWith("/media-assets")) {
      return new Response(
        JSON.stringify({
          mediaAssetId: "meme-asset",
          originalFilename: "felix-meme.svg",
          declaredMediaType: "image/svg+xml",
          lifecycleState: "published",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ event: { sequence: "9" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await new PlatformClient("http://api.test", "global-lobby").postImage(
      "bot-felix",
      {
        data: "PHN2Zz48L3N2Zz4=",
        mediaType: "image/svg+xml",
        filename: "felix-meme.svg",
        caption: "Meme by Felix",
        altText: "A meme about a surprising test result.",
      },
      { contentItemId: "human-message" },
      [{ targetType: "actor", actorId: "human-one" }],
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.body.mediaKind, "image");
    assert.deepEqual(requests[1]?.body, {
      actorId: "bot-felix",
      parts: [
        {
          kind: "image",
          mediaAssetId: "meme-asset",
          caption: "Meme by Felix",
          altText: "A meme about a surprising test result.",
        },
      ],
      replyTo: { contentItemId: "human-message" },
      addressedTo: [{ targetType: "actor", actorId: "human-one" }],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
