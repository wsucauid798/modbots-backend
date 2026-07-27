export type SupportedChatLanguage = "en" | "zh-CN";

export interface TranslationRequest {
  texts: string[];
  sourceLanguage: string;
  targetLanguage: SupportedChatLanguage;
}

export interface TranslationService {
  translate(request: TranslationRequest): Promise<string[]>;
}

export class MlTranslationService implements TranslationService {
  public constructor(private readonly mlUrl: string) {}

  public async translate(request: TranslationRequest): Promise<string[]> {
    const response = await fetch(new URL("/v1/translate", this.mlUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`ML translation returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { translations?: unknown };

    if (
      !Array.isArray(payload.translations) ||
      payload.translations.length !== request.texts.length ||
      payload.translations.some(
        (text) => typeof text !== "string" || text.trim().length === 0,
      )
    ) {
      throw new Error("ML translation returned an invalid response");
    }

    return payload.translations as string[];
  }
}
