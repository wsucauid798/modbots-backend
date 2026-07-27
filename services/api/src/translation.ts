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
  private readonly cache = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();

  public constructor(
    private readonly mlUrl: string,
    private readonly maximumCacheEntries = 5_000,
  ) {}

  public async translate(request: TranslationRequest): Promise<string[]> {
    if (request.sourceLanguage === request.targetLanguage) {
      return [...request.texts];
    }

    const results: Array<Promise<string> | undefined> = new Array(
      request.texts.length,
    );
    const misses = new Map<
      string,
      { text: string; resultIndexes: number[] }
    >();

    request.texts.forEach((text, index) => {
      const key = this.cacheKey(request, text);
      const cached = this.cache.get(key);

      if (cached !== undefined) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        results[index] = Promise.resolve(cached);
        return;
      }

      const pending = this.pending.get(key);

      if (pending !== undefined) {
        results[index] = pending;
        return;
      }

      const miss = misses.get(key);

      if (miss === undefined) {
        misses.set(key, { text, resultIndexes: [index] });
      } else {
        miss.resultIndexes.push(index);
      }
    });

    const missingEntries = [...misses.entries()];

    if (missingEntries.length > 0) {
      const batch = this.requestTranslations({
        ...request,
        texts: missingEntries.map(([, miss]) => miss.text),
      });

      missingEntries.forEach(([key, miss], batchIndex) => {
        const translation = batch.then((translations) => {
          const value = translations[batchIndex];

          if (value === undefined) {
            throw new Error("ML translation returned an invalid response");
          }

          this.store(key, value);
          return value;
        });
        this.pending.set(key, translation);

        for (const resultIndex of miss.resultIndexes) {
          results[resultIndex] = translation;
        }

        void translation.then(
          () => this.clearPending(key, translation),
          () => this.clearPending(key, translation),
        );
      });
    }

    return Promise.all(
      results.map((result) => {
        if (result === undefined) {
          throw new Error("Translation result was not scheduled");
        }

        return result;
      }),
    );
  }

  private cacheKey(request: TranslationRequest, text: string): string {
    return `${request.sourceLanguage}\u0000${request.targetLanguage}\u0000${text}`;
  }

  private store(key: string, translation: string): void {
    this.cache.set(key, translation);

    while (this.cache.size > this.maximumCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;

      if (oldest === undefined) {
        break;
      }

      this.cache.delete(oldest);
    }
  }

  private clearPending(key: string, translation: Promise<string>): void {
    if (this.pending.get(key) === translation) {
      this.pending.delete(key);
    }
  }

  private async requestTranslations(
    request: TranslationRequest,
  ): Promise<string[]> {
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
