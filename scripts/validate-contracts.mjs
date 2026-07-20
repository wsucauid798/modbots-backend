import { readFile, readdir } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const backendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractsDirectory = join(backendRoot, "contracts");
const contentDocumentationPath = join(
  backendRoot,
  "_docs",
  "content-model.md",
);

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const canonicalize = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(ajv);

const contractFiles = (await readdir(contractsDirectory))
  .filter((file) => file.endsWith(".schema.json"))
  .sort();

for (const contractFile of contractFiles) {
  const schema = await readJson(join(contractsDirectory, contractFile));
  ajv.addSchema(schema);
}

const contentSchemaId =
  "https://modbots.dev/contracts/content-v1.schema.json";
const validateContent = ajv.getSchema(contentSchemaId);

if (!validateContent) {
  throw new Error(`Schema was not registered: ${contentSchemaId}`);
}

const examples = await readJson(
  join(contractsDirectory, "content-v1.examples.json"),
);

for (const [index, example] of examples.entries()) {
  if (!validateContent(example)) {
    throw new Error(
      `Contract example ${index} failed validation:\n${ajv.errorsText(
        validateContent.errors,
        { separator: "\n" },
      )}`,
    );
  }
}

const inferenceSchemaId =
  "https://modbots.dev/contracts/inference-v1.schema.json";
const validateInference = ajv.getSchema(inferenceSchemaId);

if (!validateInference) {
  throw new Error(`Schema was not registered: ${inferenceSchemaId}`);
}

const inferenceExamples = await readJson(
  join(contractsDirectory, "inference-v1.examples.json"),
);

for (const [index, example] of inferenceExamples.entries()) {
  if (!validateInference(example)) {
    throw new Error(
      `Inference contract example ${index} failed validation:\n${ajv.errorsText(
        validateInference.errors,
        { separator: "\n" },
      )}`,
    );
  }
}

const inferenceManifest = await readJson(
  join(contractsDirectory, "inference-manifest.json"),
);

if (!validateInference(inferenceManifest)) {
  throw new Error(
    `Inference manifest failed validation:\n${ajv.errorsText(
      validateInference.errors,
      { separator: "\n" },
    )}`,
  );
}

const inferencePublicKey = await readJson(
  join(contractsDirectory, "inference-manifest-public-key.json"),
);
const { signature: manifestSignature, ...unsignedInferenceManifest } =
  inferenceManifest;
const signatureIsValid = verify(
  null,
  Buffer.from(canonicalize(unsignedInferenceManifest), "utf8"),
  createPublicKey({
    key: Buffer.from(inferencePublicKey.spki, "base64"),
    format: "der",
    type: "spki",
  }),
  Buffer.from(manifestSignature.value, "base64"),
);

if (
  manifestSignature.keyId !== inferencePublicKey.keyId ||
  manifestSignature.algorithm !== inferencePublicKey.algorithm ||
  !signatureIsValid
) {
  throw new Error("Inference manifest signature validation failed.");
}

const documentation = await readFile(contentDocumentationPath, "utf8");
const documentedJsonBlocks = [
  ...documentation.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g),
];

if (documentedJsonBlocks.length === 0) {
  throw new Error("No JSON contract examples were found in content-model.md");
}

for (const [index, match] of documentedJsonBlocks.entries()) {
  const example = JSON.parse(match[1]);

  if (!validateContent(example)) {
    throw new Error(
      `Documented JSON example ${index} failed validation:\n${ajv.errorsText(
        validateContent.errors,
        { separator: "\n" },
      )}`,
    );
  }
}

console.log(
  `Validated ${contractFiles.length} schemas, ` +
    `${examples.length + inferenceExamples.length + 1} fixtures, and ` +
    `${documentedJsonBlocks.length} documented examples.`,
);
