import { DISCLAIMER } from "./engine.js";
import { RULES } from "./rules.js";

// Static and deterministic: this is the conformance sample, so it never touches the network.
export const ABOUT = {
  name: "Multiverse",
  rules_version: RULES.version,
  chain: "eip155:8453",
  venue_scope: "Tokens with a Uniswap V2 TOKEN/WETH pair on Base. Anything else returns UNSUPPORTED_VENUE.",
  scenarios: [
    { id: "now", sender: "user wallet", size: "1x", sell: "100%", when: "next block" },
    { id: "t_10m / t_1h / t_6h / t_24h", sender: "user wallet", size: "1x", sell: "100%", when: "after the hold (requested horizons)" },
    { id: "size_quarter", sender: "user wallet", size: "0.25x", sell: "100%", when: "next block" },
    { id: "size_4x", sender: "user wallet", size: "4x", sell: "100%", when: "next block" },
    { id: "sequence", sender: "user wallet", size: "1x", sell: "50% then 50%", when: "next two blocks" },
    { id: "wallet_b", sender: "fresh deterministic address", size: "1x", sell: "100%", when: "next block" },
    { id: "wallet_c", sender: "second fresh deterministic address", size: "1x", sell: "100%", when: "after 1h (next block if 1h is not requested)" },
  ],
  rules: [
    { flag: "BUY_FAILS_NOW", condition: "the 1x buy from the user wallet reverts", effect: "BLOCK" },
    { flag: "SELL_FAILS_NOW", condition: "selling right after buying fails", effect: "BLOCK" },
    { flag: "SELL_BREAKS_LATER", condition: `selling works now but a later hold fails or its sell tax exceeds ${RULES.laterSellTaxBreakPct}%`, effect: "BLOCK" },
    { flag: "SECOND_SELL_FAILS", condition: "in the split sell, the second half fails", effect: "BLOCK" },
    { flag: "PARTIAL_SELL_FAILS", condition: "selling 100% works but selling half fails", effect: "BLOCK" },
    { flag: "WALLET_DEPENDENT", condition: `a fresh wallet succeeds or fails differently from the user wallet at the same hold, or taxes differ by more than ${RULES.walletTaxDeltaPts} points`, effect: "BLOCK" },
    { flag: "SIZE_DEPENDENT", condition: `the 0.25x or 4x trade fails, or its tax exceeds the 1x tax by more than ${RULES.sizeTaxDeltaPts} points`, effect: "CAUTION (reports the largest size that passed)" },
    { flag: "TAX_RISES_LATER", condition: `a later hold's sell tax is more than ${RULES.consistentBandPts} points above now (and at most ${RULES.laterSellTaxBreakPct}%)`, effect: "CAUTION" },
    { flag: "TAX_DECREASES_LATER", condition: `a later hold's sell tax is more than ${RULES.consistentBandPts} points below now`, effect: "CAUTION (waiting lowers the cost)" },
    { flag: "TAX_ABOVE_LIMIT", condition: "the buy tax or the immediate sell tax exceeds max_tax_pct", effect: "CAUTION" },
    { flag: "THIN_LIQUIDITY", condition: `the pool holds less than ${RULES.thinLiquidityWeth} WETH`, effect: "CAUTION" },
    { flag: "TAX_VARIES", condition: `everything succeeds but taxes spread more than ${RULES.consistentBandPts} points and no other flag explains it`, effect: "CAUTION" },
    { flag: "INCOMPLETE", condition: "a planned universe could not be simulated (timeout or RPC error)", effect: "INCOMPLETE unless a BLOCK flag fired" },
  ],
  thresholds: {
    later_sell_tax_break_pct: RULES.laterSellTaxBreakPct,
    wallet_tax_delta_pts: RULES.walletTaxDeltaPts,
    size_tax_delta_pts: RULES.sizeTaxDeltaPts,
    consistent_band_pts: RULES.consistentBandPts,
    thin_liquidity_weth: RULES.thinLiquidityWeth,
    default_max_tax_pct: RULES.defaultMaxTaxPct,
  },
  verdicts: [
    { verdict: "CONSISTENT", meaning: `every universe bought and sold, taxes within ${RULES.consistentBandPts} points of each other` },
    { verdict: "CAUTION", meaning: "the trade works but behaves differently by size, time, tax level or liquidity" },
    { verdict: "BLOCK", meaning: "some universe cannot exit, or the token treats wallets differently" },
    { verdict: "UNSUPPORTED_VENUE", meaning: "no Uniswap V2 WETH pair on Base; nothing was simulated" },
    { verdict: "INCOMPLETE", meaning: "not every universe could be simulated; no conclusion" },
  ],
  limitations: [
    "Uniswap V2 WETH pairs on Base only.",
    "Simulation cannot foresee owner actions such as pausing, blacklisting or changing taxes later; consistent is not a guarantee.",
    "Block-number gaps are capped at 200 blocks per simulation (the RPC allows 256), so long horizons mostly advance the clock.",
    "Results depend on the current pool state; large trades move the price, and other traders are not simulated.",
    "Read-only: nothing is deployed or broadcast; multiverse_buy returns at most one unsigned proposal for PayBox to approve.",
  ],
  disclaimer: DISCLAIMER,
};
