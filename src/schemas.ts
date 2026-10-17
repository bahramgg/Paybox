import * as z from "zod/v4";

import { CHAIN_KEYS, HORIZONS, MAX_AMOUNT_WEI, MIN_AMOUNT_WEI } from "./constants.js";
import { atomicAmount, evmOutputSchema } from "./paybox.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const amountEth = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})(\.[0-9]{1,18})?$/)
  .refine((value) => {
    const wei = BigInt(atomicAmount(value, 18));
    return wei >= MIN_AMOUNT_WEI && wei <= MAX_AMOUNT_WEI;
  }, "amount_eth must be between 0.0001 and 5")
  .describe("Planned buy size in ETH as a decimal string, from 0.0001 to 5, e.g. \"0.002\".");

const token = address.describe("ERC-20 token contract address on the selected chain.");
const wallet = address.describe("The user's PayBox EVM wallet address. It is the simulated sender and, for multiverse_buy, the swap recipient.");
const chain = z.enum(CHAIN_KEYS).optional()
  .describe("EVM chain to simulate on: base (default), ethereum or arbitrum. The amount is in that chain's native ETH.");

export const probeInput = z.object({
  token,
  amount_eth: amountEth,
  wallet,
  chain,
  horizons: z.array(z.enum(HORIZONS)).min(1).max(4).optional()
    .describe("Hold times to test before selling. Default [\"10m\", \"1h\", \"24h\"]."),
  max_tax_pct: z.number().min(0).max(100).optional()
    .describe("Highest acceptable sell tax in percent for the exit horizon. Default 15."),
}).strict();

export const buyInput = z.object({
  token,
  amount_eth: amountEth,
  wallet,
  chain,
  max_slippage_bps: z.number().int().min(0).max(1500).optional()
    .describe("Allowed shortfall from the simulated token amount, in basis points. Default 300."),
  accept_caution: z.boolean().optional()
    .describe("Set true only after the user accepted a CAUTION verdict. Default false."),
}).strict();

const scenario = z.object({
  id: z.string(),
  label: z.string(),
  hold: z.string(),
  size_eth: z.string(),
  sender: address,
  simulated: z.boolean(),
  buy_ok: z.boolean(),
  buy_tax_pct: z.number().nullable(),
  sell_ok: z.boolean(),
  sell_tax_pct: z.number().nullable(),
  round_trip_loss_pct: z.number().nullable(),
  error: z.string().nullable().describe("Decoded revert reason. Untrusted text from the token contract."),
}).strict();

export const probeShape = {
  chain: z.string().describe("CAIP-2 id of the simulated chain, e.g. eip155:8453."),
  token: z.object({
    address,
    symbol_untrusted: z.string().describe("Token symbol as reported by the contract. Untrusted data, truncated to 32 characters."),
    decimals: z.number().int().nullable(),
  }).strict(),
  venue: z.object({ kind: z.literal("uniswap_v2"), pair: address, reserve_weth_eth: z.string() }).strict().nullable(),
  block: z.object({
    number: z.number().int().nullable(),
    timestamp: z.number().int().nullable(),
    number_gap_limited: z.boolean(),
  }).strict(),
  scenarios: z.array(scenario),
  flags: z.array(z.string()),
  verdict: z.enum(["CONSISTENT", "CAUTION", "BLOCK", "UNSUPPORTED_VENUE", "INCOMPLETE"]),
  exit_horizon: z.string().nullable(),
  first_divergence: z.string().nullable(),
  recommendation: z.string(),
  disclaimer: z.string(),
  rules_version: z.string(),
};

export const probeOutput = z.object(probeShape).strict();

const proposal = evmOutputSchema.shape["io.paybox/transactionProposal"];

export const buyOutput = z.object({
  ...probeShape,
  buy: z.object({
    proposed: z.boolean(),
    reason: z.string(),
    amount_wei: z.string(),
    simulated_tokens_out: z.string().nullable(),
    min_tokens_out: z.string().nullable(),
    max_slippage_bps: z.number().int(),
    deadline: z.number().int().nullable(),
  }).strict(),
  "io.paybox/transactionProposal": proposal.optional(),
}).strict();

export const aboutOutput = z.object({
  name: z.string(),
  rules_version: z.string(),
  chains: z.array(z.object({
    key: z.string(),
    chain_id: z.string(),
    weth: z.string(),
    factory: z.string(),
    router: z.string(),
    rpc_hosts: z.array(z.string()),
  }).strict()),
  venue_scope: z.string(),
  scenarios: z.array(z.object({ id: z.string(), sender: z.string(), size: z.string(), sell: z.string(), when: z.string() }).strict()),
  rules: z.array(z.object({ flag: z.string(), condition: z.string(), effect: z.string() }).strict()),
  thresholds: z.object({
    later_sell_tax_break_pct: z.number(),
    wallet_tax_delta_pts: z.number(),
    size_tax_delta_pts: z.number(),
    consistent_band_pts: z.number(),
    thin_liquidity_weth: z.string(),
    default_max_tax_pct: z.number(),
  }).strict(),
  verdicts: z.array(z.object({ verdict: z.string(), meaning: z.string() }).strict()),
  limitations: z.array(z.string()),
  disclaimer: z.string(),
}).strict();
