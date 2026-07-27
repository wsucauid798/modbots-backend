import assert from "node:assert/strict";
import { test } from "node:test";
import { MlTranslationService } from "./translation.js";

test("caches translations across repeated requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = async (_input, init) => {
    requestCount += 1;
    const request = JSON.parse(String(init?.body)) as { texts: string[] };
    return new Response(
      JSON.stringify({
        translations: request.texts.map((text) => `中文：${text}`),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const translations = new MlTranslationService("http://ml.test");
    const request = {
      texts: ["Hello", "Hello", "How are you?"],
      sourceLanguage: "en",
      targetLanguage: "zh-CN" as const,
    };

    const first = await translations.translate(request);
    const second = await translations.translate(request);

    assert.deepEqual(first, ["中文：Hello", "中文：Hello", "中文：How are you?"]);
    assert.deepEqual(second, first);
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("coalesces concurrent requests for the same translation", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;

  globalThis.fetch = async () => {
    requestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response(JSON.stringify({ translations: ["你好"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const translations = new MlTranslationService("http://ml.test");
    const request = {
      texts: ["Hello"],
      sourceLanguage: "en",
      targetLanguage: "zh-CN" as const,
    };

    const [first, second] = await Promise.all([
      translations.translate(request),
      translations.translate(request),
    ]);

    assert.deepEqual(first, ["你好"]);
    assert.deepEqual(second, ["你好"]);
    assert.equal(requestCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not call inference when source and target languages match", async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("Inference must not be called");
  };

  try {
    const translations = new MlTranslationService("http://ml.test");
    const result = await translations.translate({
      texts: ["Already English"],
      sourceLanguage: "en",
      targetLanguage: "en",
    });

    assert.deepEqual(result, ["Already English"]);
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
