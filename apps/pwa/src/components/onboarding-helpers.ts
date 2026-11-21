export interface QuizChallenge {
  readonly wordIndex: number;
  readonly expectedWord: string;
  readonly choices: readonly string[];
}

const FALLBACK_DECOY_WORDS = [
  "orbit",
  "nebula",
  "cosmos",
  "anchor",
  "beacon",
  "voyage",
] as const;

function randomIndex(maxExclusive: number): number {
  if (maxExclusive <= 1) return 0;
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    const buf = new Uint32Array(1);
    while (true) {
      cryptoObj.getRandomValues(buf);
      const val = buf[0] ?? 0;
      if (val < limit) {
        return val % maxExclusive;
      }
    }
  }
  return Math.floor(Math.random() * maxExclusive);
}

function shuffleItems<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1);
    const current = arr[i];
    const target = arr[j];
    if (current !== undefined && target !== undefined) {
      arr[i] = target;
      arr[j] = current;
    }
  }
  return arr;
}

/**
 * Selects sorted unique 0-based word indices from a mnemonic phrase using CSPRNG randomness.
 */
export function pickVerificationIndices(wordCount: number, count = 3): number[] {
  if (wordCount <= 0 || count <= 0) return [];
  const targetCount = Math.min(wordCount, count);
  const pool: number[] = [];
  for (let i = 0; i < wordCount; i += 1) {
    pool.push(i);
  }
  return shuffleItems(pool)
    .slice(0, targetCount)
    .sort((a, b) => a - b);
}

/**
 * Builds shuffled 4-option verification challenges for specific mnemonic word positions.
 */
export function buildWordQuizChallenges(
  words: readonly string[],
  indices?: readonly number[],
): QuizChallenge[] {
  const targetIndices = indices ? [...indices] : pickVerificationIndices(words.length, 3);
  const uniquePhraseWords = Array.from(
    new Set(words.map((w) => w.trim().toLowerCase()).filter((w) => w.length > 0)),
  );

  return targetIndices.map((wordIndex) => {
    const expectedWord = (words[wordIndex] ?? "").trim().toLowerCase();
    const decoyCandidates = shuffleItems(
      uniquePhraseWords.filter((w) => w !== expectedWord),
    );
    const decoys: string[] = [];
    for (const candidate of decoyCandidates) {
      if (decoys.length >= 3) break;
      if (!decoys.includes(candidate)) {
        decoys.push(candidate);
      }
    }

    if (decoys.length < 3) {
      for (const fallback of shuffleItems(FALLBACK_DECOY_WORDS)) {
        if (decoys.length >= 3) break;
        if (fallback !== expectedWord && !decoys.includes(fallback)) {
          decoys.push(fallback);
        }
      }
    }

    return {
      wordIndex,
      expectedWord,
      choices: shuffleItems([expectedWord, ...decoys]),
    };
  });
}

/**
 * Counts whitespace-delimited words entered into a seed import field.
 */
export function parseSeedWordCount(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Formats a deterministic date-stamped filename for `.agvault.json` encrypted backups.
 */
export function formatSeedBackupFilename(network: string, now = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const safeNet = network.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "stellar";
  return `astrowallet-${safeNet}-vault-${yyyy}-${mm}-${dd}.agvault.json`;
}
