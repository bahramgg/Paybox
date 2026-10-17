import type { Address } from "viem";

import { quotable } from "./text.js";

// OWNER RULES v1. The numbers are the plugin owner's policy; change them here and in README.
export const RULES = {
  version: "owner-rules-v1",
  laterSellTaxBreakPct: 50,
  walletTaxDeltaPts: 10,
  sizeTaxDeltaPts: 20,
  consistentBandPts: 3,
  thinLiquidityWeth: "0.5",
  defaultMaxTaxPct: 15,
} as const;

export const BLOCK_FLAGS = [
  "BUY_FAILS_NOW",
  "SELL_FAILS_NOW",
  "SELL_BREAKS_LATER",
  "SECOND_SELL_FAILS",
  "PARTIAL_SELL_FAILS",
  "WALLET_DEPENDENT",
] as const;
export const CAUTION_FLAGS = [
  "SIZE_DEPENDENT",
  "TAX_RISES_LATER",
  "TAX_DECREASES_LATER",
  "TAX_ABOVE_LIMIT",
  "THIN_LIQUIDITY",
  "TAX_VARIES",
] as const;
export type Flag = (typeof BLOCK_FLAGS)[number] | (typeof CAUTION_FLAGS)[number] | "INCOMPLETE";
export type Verdict = "CONSISTENT" | "CAUTION" | "BLOCK" | "UNSUPPORTED_VENUE" | "INCOMPLETE";

export type ScenarioKind = "now" | "horizon" | "size" | "sequence" | "wallet";

export interface Outcome {
  id: string;
  label: string;
  kind: ScenarioKind;
  hold: string; // "now" or a horizon label
  holdSeconds: number;
  sizeFactor: number;
  sizeEth: string;
  sender: Address;
  freshWallet: boolean;
  simulated: boolean;
  buyOk: boolean;
  buyTaxPct: number | null;
  sellOk: boolean;
  sellTaxPct: number | null;
  roundTripLossPct: number | null;
  error: string | null;
  failedSellStep: number | null; // 1-based, for the split sell
}

export interface Evaluation {
  flags: Flag[];
  verdict: Exclude<Verdict, "UNSUPPORTED_VENUE">;
  exitHorizon: string | null;
  divergence: string | null; // first BLOCK reason, else first CAUTION reason
  largestSizeOk: number | null;
}

const reason = (outcome: Outcome) => (outcome.error ? ` (revert: "${quotable(outcome.error, 60)}")` : "");
const taxGap = (a: number | null, b: number | null) => (a === null || b === null ? 0 : Math.abs(a - b));
const works = (outcome: Outcome | undefined): outcome is Outcome => !!outcome?.simulated && outcome.buyOk && outcome.sellOk;

export function evaluate(outcomes: Outcome[], options: { reserveWethWei: bigint | null; maxTaxPct: number }): Evaluation {
  const notes = new Map<Flag, string>();
  const flag = (name: Flag, note: string) => {
    if (!notes.has(name)) notes.set(name, note);
  };
  const byId = (id: string) => outcomes.find((outcome) => outcome.id === id);
  const now = byId("now");
  const later = outcomes.filter((outcome) => outcome.kind === "horizon" && outcome.simulated).sort((a, b) => a.holdSeconds - b.holdSeconds);

  if (now?.simulated && !now.buyOk) flag("BUY_FAILS_NOW", `the buy itself reverts${reason(now)}`);
  else if (now?.simulated && !now.sellOk) flag("SELL_FAILS_NOW", `selling right after buying fails${reason(now)}`);

  if (works(now)) {
    const nowSell = now.sellTaxPct ?? 0;
    for (const outcome of later) {
      if (!outcome.buyOk || !outcome.sellOk) {
        flag("SELL_BREAKS_LATER", `selling works now but fails after holding ${outcome.hold}${reason(outcome)}`);
      } else if ((outcome.sellTaxPct ?? 0) > RULES.laterSellTaxBreakPct) {
        flag("SELL_BREAKS_LATER", `sell tax jumps from ${nowSell}% now to ${outcome.sellTaxPct}% after holding ${outcome.hold}`);
      } else if ((outcome.sellTaxPct ?? 0) > nowSell + RULES.consistentBandPts) {
        flag("TAX_RISES_LATER", `sell tax rises from ${nowSell}% now to ${outcome.sellTaxPct}% after holding ${outcome.hold}`);
      } else if ((outcome.sellTaxPct ?? 0) < nowSell - RULES.consistentBandPts) {
        flag("TAX_DECREASES_LATER", `sell tax falls from ${nowSell}% now to ${outcome.sellTaxPct}% after holding ${outcome.hold}, so waiting ${outcome.hold} lowers the exit cost`);
      }
    }

    const sequence = byId("sequence");
    if (sequence?.simulated && sequence.buyOk && !sequence.sellOk) {
      if (sequence.failedSellStep === 2) flag("SECOND_SELL_FAILS", `the first half sells but the second half fails${reason(sequence)}`);
      else flag("PARTIAL_SELL_FAILS", `selling 100% works but selling only half fails${reason(sequence)}`);
    }

    for (const id of ["size_quarter", "size_4x"]) {
      const outcome = byId(id);
      if (!outcome?.simulated) continue;
      if (!outcome.buyOk || !outcome.sellOk) {
        flag("SIZE_DEPENDENT", `a ${outcome.sizeEth} ETH trade fails${reason(outcome)}`);
      } else if (
        (outcome.sellTaxPct ?? 0) > nowSell + RULES.sizeTaxDeltaPts ||
        (outcome.buyTaxPct ?? 0) > (now.buyTaxPct ?? 0) + RULES.sizeTaxDeltaPts
      ) {
        flag("SIZE_DEPENDENT", `a ${outcome.sizeEth} ETH trade is taxed far more (buy ${outcome.buyTaxPct}%, sell ${outcome.sellTaxPct}%)`);
      }
    }
  }

  // Fresh wallets are compared with the user's wallet at the same hold time.
  for (const fresh of outcomes.filter((outcome) => outcome.freshWallet && outcome.simulated)) {
    const mine = outcomes.find(
      (outcome) => !outcome.freshWallet && outcome.simulated && outcome.sizeFactor === 1 && outcome.kind !== "sequence" && outcome.holdSeconds === fresh.holdSeconds,
    );
    if (!mine) continue;
    const differs = mine.buyOk !== fresh.buyOk || mine.sellOk !== fresh.sellOk ||
      taxGap(mine.sellTaxPct, fresh.sellTaxPct) > RULES.walletTaxDeltaPts ||
      taxGap(mine.buyTaxPct, fresh.buyTaxPct) > RULES.walletTaxDeltaPts;
    if (differs) {
      const describe = (outcome: Outcome) => (works(outcome) ? `sells at ${outcome.sellTaxPct}% tax` : "cannot complete the trade");
      flag("WALLET_DEPENDENT", `your wallet ${describe(mine)} but a fresh wallet ${describe(fresh)} (hold ${fresh.hold})`);
    }
  }

  if (options.reserveWethWei !== null && options.reserveWethWei < 500_000_000_000_000_000n) {
    flag("THIN_LIQUIDITY", `the pool holds less than ${RULES.thinLiquidityWeth} WETH, so prices move sharply and liquidity can vanish`);
  }

  // Exit horizon: the longest tested hold where the sell succeeds within the tax limit.
  let exitHorizon: string | null = null;
  for (const outcome of [now, ...later]) {
    if (works(outcome) && (outcome.sellTaxPct ?? 0) <= options.maxTaxPct) exitHorizon = outcome.hold;
  }
  if (works(now) && ((now.buyTaxPct ?? 0) > options.maxTaxPct || (now.sellTaxPct ?? 0) > options.maxTaxPct)) {
    flag("TAX_ABOVE_LIMIT", `buying now costs ${now.buyTaxPct}% tax and selling ${now.sellTaxPct}%, above the ${options.maxTaxPct}% limit`);
  }

  const simulated = outcomes.filter((outcome) => outcome.simulated);
  const anyCaution = CAUTION_FLAGS.some((name) => notes.has(name));
  const anyBlock = BLOCK_FLAGS.some((name) => notes.has(name));
  if (!anyBlock && !anyCaution && simulated.length > 0 && simulated.every(works)) {
    const spread = (values: Array<number | null>) => {
      const known = values.filter((value): value is number => value !== null);
      return known.length ? Math.max(...known) - Math.min(...known) : 0;
    };
    const buySpread = spread(simulated.map((outcome) => outcome.buyTaxPct));
    const sellSpread = spread(simulated.map((outcome) => outcome.sellTaxPct));
    if (buySpread > RULES.consistentBandPts || sellSpread > RULES.consistentBandPts) {
      flag("TAX_VARIES", `taxes differ by up to ${Math.round(Math.max(buySpread, sellSpread) * 10) / 10} points between universes`);
    }
  }

  if (outcomes.some((outcome) => !outcome.simulated)) flag("INCOMPLETE", "some universes could not be simulated");

  const flags = [...BLOCK_FLAGS, ...CAUTION_FLAGS, "INCOMPLETE" as const].filter((name) => notes.has(name));
  const verdict = BLOCK_FLAGS.some((name) => notes.has(name)) ? "BLOCK"
    : notes.has("INCOMPLETE") ? "INCOMPLETE"
    : CAUTION_FLAGS.some((name) => notes.has(name)) ? "CAUTION"
    : "CONSISTENT";
  const firstFlag = flags.find((name) => name !== "INCOMPLETE") ?? flags[0];

  let largestSizeOk: number | null = null;
  if (works(now)) {
    for (const outcome of [byId("size_quarter"), now, byId("size_4x")]) {
      if (!works(outcome)) continue;
      if ((outcome.sellTaxPct ?? 0) > (now.sellTaxPct ?? 0) + RULES.sizeTaxDeltaPts) continue;
      if ((outcome.buyTaxPct ?? 0) > (now.buyTaxPct ?? 0) + RULES.sizeTaxDeltaPts) continue;
      largestSizeOk = Math.max(largestSizeOk ?? 0, outcome.sizeFactor);
    }
  }

  return { flags, verdict, exitHorizon, divergence: firstFlag ? (notes.get(firstFlag) ?? null) : null, largestSizeOk };
}
