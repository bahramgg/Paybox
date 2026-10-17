import { getAddress, parseAbi, parseEther, type Address } from "viem";

export const CHAIN = "eip155:8453";
export const WETH: Address = getAddress("0x4200000000000000000000000000000000000006");
export const V2_FACTORY: Address = getAddress("0x8909dc15e40173ff4699343b6eb8132c65e18ec6");
export const V2_ROUTER: Address = getAddress("0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24");

// Primary first. The fallback is only used when the primary is saturated or failing.
export const RPC_URLS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"] as const;

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
