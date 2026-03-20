export const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  10: "Optimism",
  137: "Polygon",
  2020: "Ronin",
  8453: "Base",
  42161: "Arbitrum",
  59144: "Linea",
  534352: "Scroll",
  5000: "Mantle",
  130: "Unichain",
};

export const CHAIN_COLORS: Record<number, string> = {
  1: "gray",
  10: "red",
  137: "purple",
  2020: "blue",
  8453: "blue",
  42161: "blue",
  59144: "green",
  534352: "orange",
  5000: "gray",
  130: "purple",
};

/**
 * Static tx gas limits per chain (approximate block gas limits).
 * Ethereum uses 16M as the practical governance tx gas limit (per Compound conventions).
 */
export const CHAIN_TX_GAS_LIMITS: Record<number, number> = {
  1: 16_000_000, // Ethereum — governance proposals should not exceed this
  10: 30_000_000, // Optimism
  137: 30_000_000, // Polygon
  2020: 100_000_000, // Ronin
  8453: 30_000_000, // Base
  42161: 32_000_000, // Arbitrum
  59144: 61_000_000, // Linea
  534352: 10_000_000, // Scroll
  5000: 30_000_000, // Mantle
  130: 30_000_000, // Unichain
};

export function getChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;
}

export function getChainColor(chainId: number): string {
  return CHAIN_COLORS[chainId] ?? "gray";
}

export function getChainTxGasLimit(chainId: number): number | undefined {
  return CHAIN_TX_GAS_LIMITS[chainId];
}
