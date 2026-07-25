interface DashboardCostSummary {
  cost: { amount: string; currency: string } | null;
  costBreakdown: { amount: string; currency: string }[];
}

export function formatDashboardCost(
  summary: DashboardCostSummary,
  notConvertedSuffix = '（按币种分别统计，未换汇）',
): string {
  if (summary.cost !== null) return `${summary.cost.amount} ${summary.cost.currency}`;
  const breakdown = summary.costBreakdown
    .map((entry) => `${entry.amount} ${entry.currency}`)
    .join(' + ');
  return `${breakdown}${notConvertedSuffix}`;
}
