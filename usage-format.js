export function formatUsageSummary(usage, costUsd, elapsedSeconds) {
  const parts = [
    `${formatNumber(usage.inputTokens)} in`,
    `${formatNumber(usage.outputTokens)} out`,
    `${formatNumber(usage.totalTokens)} total`,
  ];

  if (typeof costUsd === "number") parts.push(`est. ${formatCost(costUsd)}`);
  if (typeof elapsedSeconds === "number") parts.push(`${elapsedSeconds}s`);

  return parts.join(" • ");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatCost(value) {
  if (value === 0) return "$0.0000";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(3)}`;
}
