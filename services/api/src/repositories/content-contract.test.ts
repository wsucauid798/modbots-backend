import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { contentItemFromRow } from "./content.js";
import type { ContentItemRow } from "./content.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "contracts",
  "content-v1.schema.json",
);
const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;

const ajv = new Ajv2020({ allErrors: true });
addFormats.default(ajv);
const validate = ajv.compile(schema);

const baseRow: ContentItemRow = {
  id: "11111111-2222-4333-8444-555555555555",
  room_id: "global-lobby",
  room_sequence: "42",
  actor_id: "66666666-7777-4888-9999-000000000000",
  lifecycle_state: "published",
  revision: 1,
  reply_to: null,
  parts: [
    {
      partId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      kind: "text",
      text: "A text contribution",
    },
  ],
  refs: [],
  created_at: new Date("2026-07-02T09:30:00Z"),
  updated_at: new Date("2026-07-02T09:30:00Z"),
};

describe("content item contract", () => {
  it("emits schema-valid content items", () => {
    const entity = contentItemFromRow(baseRow);

    assert.equal(validate(entity), true, JSON.stringify(validate.errors));
    assert.equal(entity.contractVersion, 1);
    assert.equal(entity.entityType, "content_item");
    assert.equal(entity.roomSequence, "42");
  });

  it("emits schema-valid replies with references", () => {
    const entity = contentItemFromRow({
      ...baseRow,
      lifecycle_state: "edited",
      revision: 3,
      reply_to: {
        contentItemId: "content-41",
        contentPartId: "part-image",
      },
      refs: [
        {
          relationshipType: "context",
          target: {
            targetType: "content_item",
            contentItemId: "content-41",
          },
        },
      ],
      updated_at: new Date("2026-07-02T09:31:00Z"),
    });

    assert.equal(validate(entity), true, JSON.stringify(validate.errors));
    assert.equal(entity.replyTo?.contentPartId, "part-image");
    assert.equal(entity.references[0]?.relationshipType, "context");
  });
});
