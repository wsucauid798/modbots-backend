import { readFileSync } from "node:fs";

export type InferenceManifest = Record<string, unknown>;

export const loadInferenceManifest = (path: string): InferenceManifest => {
  let value: unknown;

  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not load inference manifest at ${path}`, {
      cause: error,
    });
  }

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).entityType !==
      "inference_pipeline_manifest"
  ) {
    throw new Error(`Invalid inference manifest at ${path}`);
  }

  return value as InferenceManifest;
};
