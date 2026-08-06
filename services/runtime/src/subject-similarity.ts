const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "with",
]);

const subjectWords = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !stopWords.has(word))
    .map((word) => {
      if (word.length > 4 && word.endsWith("ies")) {
        return `${word.slice(0, -3)}y`;
      }

      if (word.length > 4 && word.endsWith("oes")) {
        return word.slice(0, -2);
      }

      if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
        return word.slice(0, -1);
      }

      return word;
    });

export const subjectSimilarity = (left: string, right: string): number => {
  const leftWords = new Set(subjectWords(left));
  const rightWords = new Set(subjectWords(right));

  if (leftWords.size === 0 || rightWords.size === 0) {
    return 0;
  }

  let overlap = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlap += 1;
    }
  }

  return overlap / new Set([...leftWords, ...rightWords]).size;
};
