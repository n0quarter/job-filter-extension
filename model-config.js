export const MODELS = {
  sonnet: {
    key: "sonnet",
    name: "Claude Sonnet 4.6",
    modelId: "us.anthropic.claude-sonnet-4-6",
    pricing: {
      inputCostPerMillionTokens: 3,
      outputCostPerMillionTokens: 15,
    },
  },
  haiku: {
    key: "haiku",
    name: "Claude Haiku 4.5",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    pricing: {
      inputCostPerMillionTokens: 1,
      outputCostPerMillionTokens: 5,
    },
  },
  kimi: {
    key: "kimi",
    name: "Kimi K2.5",
    modelId: "moonshotai.kimi-k2.5",
    // Structured-output duplicate-check soak test reached 37/40 success on local probes.
    // Good enough to keep available, but not the safest default yet.
    pricing: {
      inputCostPerMillionTokens: 0.6,
      outputCostPerMillionTokens: 3,
    },
  },
};

export function estimateCostUsd(usage, pricing) {
  if (!usage || !pricing) {
    return null;
  }

  const inputTokens = Number(usage.inputTokens || 0);
  const outputTokens = Number(usage.outputTokens || 0);

  return (
    (inputTokens / 1_000_000) * pricing.inputCostPerMillionTokens +
    (outputTokens / 1_000_000) * pricing.outputCostPerMillionTokens
  );
}
