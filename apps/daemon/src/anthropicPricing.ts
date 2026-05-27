export type AnthropicPricingEnv = {
  ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M?: number;
  ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M?: number;
  ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M?: number;
  ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M?: number;
};

export function estimateAnthropicCostUsd(params: {
  model: string;
  inputTokens: number;
  outputTokens: number;
  env: AnthropicPricingEnv;
}): number {
  const model = params.model.toLowerCase();
  const isSonnet = model.includes("sonnet");
  const isOpus = model.includes("opus");

  const inputPrice = isSonnet
    ? (params.env.ANTHROPIC_CLAUDE_SONNET_INPUT_USD_PER_1M ?? 3)
    : isOpus
      ? (params.env.ANTHROPIC_CLAUDE_OPUS_INPUT_USD_PER_1M ?? 15)
      : 0;
  const outputPrice = isSonnet
    ? (params.env.ANTHROPIC_CLAUDE_SONNET_OUTPUT_USD_PER_1M ?? 15)
    : isOpus
      ? (params.env.ANTHROPIC_CLAUDE_OPUS_OUTPUT_USD_PER_1M ?? 75)
      : 0;

  const input = (params.inputTokens / 1_000_000) * inputPrice;
  const output = (params.outputTokens / 1_000_000) * outputPrice;
  return Number((input + output).toFixed(6));
}
