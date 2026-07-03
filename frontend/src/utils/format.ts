// Centralized USDC formatting so every page renders amounts the same friendly way.
// USDC is a stablecoin: showing 6 decimals is noise. Default to 2 decimals + thousand separators.

export function fmtUsdc(
  value: string | number | bigint | null | undefined,
  decimals = 2,
): string {
  if (value === null || value === undefined || value === '') return '0';
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('bg-BG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
