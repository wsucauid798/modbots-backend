import { readFile, readdir } from "node:fs/promises";
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
    `${examples.length + inferenceExamples.length} fixtures, and ` +
    `${documentedJsonBlocks.length} documented examples.`,
);
