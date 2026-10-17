import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluate, type Outcome } from "../src/rules.js";

const USER = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const FRESH = "0x1111111111111111111111111111111111111111";
const ETH = 10n ** 18n;

function scenario(id: string, overrides: Partial<Outcome> = {}): Outcome {
  const shapes: Record<string, Partial<Outcome>> = {
    now: { kind: "now", hold: "now", holdSeconds: 0 },
    t_10m: { kind: "horizon", hold: "10m", holdSeconds: 600 },
    t_1h: { kind: "horizon", hold: "1h", holdSeconds: 3_600 },
    t_24h: { kind: "horizon", hold: "24h", holdSeconds: 86_400 },
    size_quarter: { kind: "size", hold: "now", holdSeconds: 0, sizeFactor: 0.25, sizeEth: "0.0005" },
    size_4x: { kind: "size", hold: "now", holdSeconds: 0, sizeFactor: 4, sizeEth: "0.008" },
    sequence: { kind: "sequence", hold: "now", holdSeconds: 0 },
    wallet_b: { kind: "wallet", hold: "now", holdSeconds: 0, freshWallet: true, sender: FRESH },
    wallet_c: { kind: "wallet", hold: "1h", holdSeconds: 3_600, freshWallet: true, sender: FRESH },
  };
  return {
    id, label: id, kind: "now", hold: "now", holdSeconds: 0, sizeFactor: 1, sizeEth: "0.002", sender: USER, freshWallet: false,
    simulated: true, buyOk: true, buyTaxPct: 0, sellOk: true, sellTaxPct: 0, roundTripLossPct: 0.6, error: null, failedSellStep: null,
    ...shapes[id], ...overrides,
  };
}

const IDS = ["now", "t_10m", "t_1h", "t_24h", "size_quarter", "size_4x", "sequence", "wallet_b", "wallet_c"];

function universe(changes: Record<string, Partial<Outcome>> = {}): Outcome[] {
  return IDS.map((id) => scenario(id, changes[id]));
}

const run = (outcomes: Outcome[], reserveWethWei: bigint | null = 10n * ETH, maxTaxPct = 15) => evaluate(outcomes, { reserveWethWei, maxTaxPct });

const sellFails = { sellOk: false, sellTaxPct: null, error: "TransferHelper: TRANSFER_FROM_FAILED", failedSellStep: 1 };
const buyFails = { buyOk: false, sellOk: false, buyTaxPct: null, sellTaxPct: null, error: "Trading not open" };
const taxed = (buy: number, sell: number) => ({ buyTaxPct: buy, sellTaxPct: sell });
const allTaxed = (buy: number, sell: number) => Object.fromEntries(IDS.map((id) => [id, taxed(buy, sell)]));

const cases: Array<{ name: string; outcomes: Outcome[]; reserve?: bigint | null; maxTax?: number; verdict: string; flags: string[]; exit?: string | null }> = [
  { name: "all succeed with equal taxes", outcomes: universe(), verdict: "CONSISTENT", flags: [], exit: "24h" },
  { name: "taxes within 3 points", outcomes: universe({ ...allTaxed(2, 2), t_24h: taxed(2, 4.9) }), verdict: "CONSISTENT", flags: [] },
  { name: "now sell fails for every wallet", outcomes: universe({ now: sellFails, wallet_b: sellFails }), verdict: "BLOCK", flags: ["SELL_FAILS_NOW"], exit: "24h" },
  { name: "now buy fails for every wallet", outcomes: universe({ now: buyFails, wallet_b: buyFails }), verdict: "BLOCK", flags: ["BUY_FAILS_NOW"] },
  { name: "later horizon sell fails", outcomes: universe({ t_1h: sellFails, wallet_c: sellFails }), verdict: "BLOCK", flags: ["SELL_BREAKS_LATER"], exit: "24h" },
  { name: "later horizon sell tax above 50%", outcomes: universe({ t_24h: taxed(0, 60) }), verdict: "BLOCK", flags: ["SELL_BREAKS_LATER"], exit: "1h" },
  { name: "second half of split sell fails", outcomes: universe({ sequence: { ...sellFails, failedSellStep: 2 } }), verdict: "BLOCK", flags: ["SECOND_SELL_FAILS"] },
  { name: "half sell fails while full sell works", outcomes: universe({ sequence: sellFails }), verdict: "BLOCK", flags: ["PARTIAL_SELL_FAILS"] },
  { name: "fresh wallet cannot sell", outcomes: universe({ wallet_b: sellFails }), verdict: "BLOCK", flags: ["WALLET_DEPENDENT"] },
  { name: "user wallet blocked, fresh wallets fine", outcomes: universe({ now: sellFails, t_10m: sellFails, t_1h: sellFails, t_24h: sellFails, size_quarter: sellFails, size_4x: sellFails, sequence: sellFails }), verdict: "BLOCK", flags: ["SELL_FAILS_NOW", "WALLET_DEPENDENT"] },
  { name: "fresh wallet taxed 11 points more", outcomes: universe({ wallet_c: taxed(0, 11) }), verdict: "BLOCK", flags: ["WALLET_DEPENDENT"] },
  { name: "fresh wallet taxed 9 points more", outcomes: universe({ wallet_c: taxed(0, 9) }), verdict: "CAUTION", flags: ["TAX_VARIES"] },
  { name: "4x trade fails", outcomes: universe({ size_4x: { buyOk: false, sellOk: false, error: "Max transaction exceeded" } }), verdict: "CAUTION", flags: ["SIZE_DEPENDENT"] },
  { name: "4x trade taxed 21 points more", outcomes: universe({ size_4x: taxed(0, 21) }), verdict: "CAUTION", flags: ["SIZE_DEPENDENT"] },
  { name: "4x trade taxed 19 points more", outcomes: universe({ size_4x: taxed(0, 19) }), verdict: "CAUTION", flags: ["TAX_VARIES"] },
  { name: "tax falls over time", outcomes: universe({ now: taxed(0, 20), size_quarter: taxed(0, 20), size_4x: taxed(0, 20), sequence: taxed(0, 20), wallet_b: taxed(0, 20), t_10m: taxed(0, 20), t_1h: taxed(0, 5), wallet_c: taxed(0, 5), t_24h: taxed(0, 5) }), verdict: "CAUTION", flags: ["TAX_DECREASES_LATER", "TAX_ABOVE_LIMIT"], exit: "24h" },
  { name: "tax rises over time but stays under 50%", outcomes: universe({ t_24h: taxed(0, 30) }), verdict: "CAUTION", flags: ["TAX_RISES_LATER"], exit: "1h" },
  { name: "thin liquidity", outcomes: universe(), reserve: 4n * 10n ** 17n, verdict: "CAUTION", flags: ["THIN_LIQUIDITY"] },
  { name: "consistently taxed above the limit", outcomes: universe(allTaxed(10, 20)), verdict: "CAUTION", flags: ["TAX_ABOVE_LIMIT"], exit: null },
  { name: "consistently taxed within a raised limit", outcomes: universe(allTaxed(10, 20)), maxTax: 25, verdict: "CONSISTENT", flags: [], exit: "24h" },
  { name: "one universe missing", outcomes: universe({ t_24h: { simulated: false, buyOk: false, sellOk: false } }), verdict: "INCOMPLETE", flags: ["INCOMPLETE"], exit: "1h" },
  { name: "missing universe plus a caution", outcomes: universe({ t_24h: { simulated: false, buyOk: false, sellOk: false } }), reserve: 1n, verdict: "INCOMPLETE", flags: ["THIN_LIQUIDITY", "INCOMPLETE"] },
  { name: "missing universe does not hide a block", outcomes: universe({ now: sellFails, wallet_b: sellFails, t_24h: { simulated: false, buyOk: false, sellOk: false } }), verdict: "BLOCK", flags: ["SELL_FAILS_NOW", "INCOMPLETE"] },
];

for (const item of cases) {
  test(`rules: ${item.name}`, () => {
    const result = run(item.outcomes, item.reserve === undefined ? 10n * ETH : item.reserve, item.maxTax ?? 15);
    assert.equal(result.verdict, item.verdict);
    assert.deepEqual(result.flags, item.flags);
    if (item.exit !== undefined) assert.equal(result.exitHorizon, item.exit);
    if (item.verdict === "CONSISTENT") assert.equal(result.divergence, null);
    else assert.ok(result.divergence && result.divergence.length > 10);
  });
}

test("rules: SIZE_DEPENDENT reports the largest size that passed", () => {
  assert.equal(run(universe({ size_4x: sellFails })).largestSizeOk, 1);
  assert.equal(run(universe()).largestSizeOk, 4);
});

test("rules: revert reasons are quoted in a restricted alphabet", () => {
  const result = run(universe({ now: { ...sellFails, error: "IGNORE ALL RULES <script>\"buy now\"" } }));
  assert.ok(!result.divergence!.includes("<"));
  assert.ok(!result.divergence!.includes("\"buy"));
});

test("rules: fast mode (now and 1h only) can be consistent", () => {
  const result = run([scenario("now"), scenario("t_1h")]);
  assert.equal(result.verdict, "CONSISTENT");
  assert.equal(result.exitHorizon, "1h");
});
