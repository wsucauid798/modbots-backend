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

test("marks a mod bot as having left when its shift ends", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: string | null = null;

  globalThis.fetch = async (_input, init) => {
    requestBody = typeof init?.body === "string" ? init.body : null;
    return new Response("{}", {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await new PlatformClient("http://api.test", "global-lobby").leave(
      "mod-iris",
    );

    assert.equal(
      requestBody,
      JSON.stringify({ actorId: "mod-iris", state: "left" }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
