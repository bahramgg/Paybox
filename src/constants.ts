import { getAddress, parseAbi, parseEther, type Address } from "viem";

export interface ChainConfig {
  key: string;
  name: string;
  caip: string;
  weth: Address;
  factory: Address;
  router: Address;
  // Primary first. The fallback is only used when the primary is saturated or failing.
  rpcUrls: readonly string[];
  // Seconds between simulated blocks, and the divisor for hold gaps, so the filler blocks the RPC
  // inserts (+2 s on Base, +12 s on Ethereum and Arbitrum) never pass the sell block's time.
  blockSeconds: number;
}

// Every router below was checked on-chain: router.factory() and router.WETH() match these values.
export const CHAINS = {
  base: {
    key: "base", name: "Base", caip: "eip155:8453",
    weth: getAddress("0x4200000000000000000000000000000000000006"),
    factory: getAddress("0x8909dc15e40173ff4699343b6eb8132c65e18ec6"),
    router: getAddress("0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24"),
    rpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    blockSeconds: 2,
  },
  ethereum: {
    key: "ethereum", name: "Ethereum", caip: "eip155:1",
    weth: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"),
    factory: getAddress("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"),
    router: getAddress("0x7a250d5630b4cf539739df2c5dacb4c659f2488d"),
    rpcUrls: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    blockSeconds: 12,
  },
  // Optimism was left out: its Uniswap V2 WETH pools hold well under 0.5 WETH (OP 0.19, DAI 0.30 on 2026-10-17).
  arbitrum: {
    key: "arbitrum", name: "Arbitrum", caip: "eip155:42161",
    weth: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"),
    factory: getAddress("0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9"),
    router: getAddress("0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24"),
    rpcUrls: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
    blockSeconds: 12,
  },
} as const satisfies Record<string, ChainConfig>;

export type ChainKey = keyof typeof CHAINS;
export const CHAIN_KEYS = ["base", "ethereum", "arbitrum"] as const satisfies readonly ChainKey[];
export const DEFAULT_CHAIN: ChainKey = "base";

export const chainByCaip = (caip: string): ChainConfig | undefined => Object.values(CHAINS).find((chain) => chain.caip === caip);

// Base aliases, kept for callers that predate multi-chain support.
export const WETH: Address = CHAINS.base.weth;
export const V2_FACTORY: Address = CHAINS.base.factory;
export const V2_ROUTER: Address = CHAINS.base.router;

export const RPC_TIMEOUT_MS = 3_500;
export const TOOL_BUDGET_MS = 8_500;
export const HOST_CONCURRENCY = 6;
export const MAX_SIM_BLOCK_GAP = 200; // reth allows 256 simulated blocks per call, filler blocks included

export const BALANCE_BUFFER_WEI = parseEther("0.05");
export const SIM_GAS = 8_000_000n;
export const SIM_PRIORITY_FEE_WEI = 1_000_000n; // 0.001 gwei, so tx.gasprice is realistic rather than zero

export const MIN_AMOUNT_WEI = parseEther("0.0001");
export const MAX_AMOUNT_WEI = parseEther("5");

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const HORIZONS = ["10m", "1h", "6h", "24h"] as const;
export type Horizon = (typeof HORIZONS)[number];
export const HORIZON_SECONDS: Record<Horizon, number> = { "10m": 600, "1h": 3_600, "6h": 21_600, "24h": 86_400 };
export const DEFAULT_HORIZONS: Horizon[] = ["10m", "1h", "24h"];

export const factoryAbi = parseAbi(["function getPair(address tokenA, address tokenB) view returns (address pair)"]);
export const pairAbi = parseAbi(["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"]);
export const routerAbi = parseAbi([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);
export const tokenAbi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
