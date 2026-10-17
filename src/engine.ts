import { decodeFunctionResult, encodeFunctionData, encodePacked, formatEther, getAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";

import { factoryAbi, HORIZON_SECONDS, MAX_SIM_BLOCK_GAP, pairAbi, tokenAbi, V2_FACTORY, WETH, type Horizon } from "./constants.js";
import { RULES, evaluate, type Flag, type Outcome, type ScenarioKind, type Verdict } from "./rules.js";
import { rpcBatch, rpcCall, type Rpc } from "./rpc.js";
import {
  approveCall, balanceCall, buyCall, callOk, decodeQuote, decodeSymbol, decodeUint, fundSender, parseHeader, quoteBuyCall,
  quoteSellCall, requestedBlocks, revertReason, sellCall, simulateRequest, sumTransfersTo, type Header, type SimBlock,
  type SimCallResult,
} from "./simulate.js";
import { lossPct, pct, taxPct } from "./text.js";

export interface ProbeParams {
  token: Address;
  amountWei: bigint;
  wallet: Address;
  horizons: Horizon[];
  maxTaxPct: number;
  mode: "full" | "fast";
}

export interface ScenarioOutput {
  id: string;
  label: string;
  hold: string;
  size_eth: string;
  sender: Address;
  simulated: boolean;
  buy_ok: boolean;
  buy_tax_pct: number | null;
  sell_ok: boolean;
  sell_tax_pct: number | null;
  round_trip_loss_pct: number | null;
  error: string | null;
}

export interface ProbeOutput {
  token: { address: Address; symbol_untrusted: string; decimals: number | null };
  venue: { kind: "uniswap_v2"; pair: Address; reserve_weth_eth: string } | null;
  block: { number: number | null; timestamp: number | null; number_gap_limited: boolean };
  scenarios: ScenarioOutput[];
  flags: Flag[];
  verdict: Verdict;
  exit_horizon: string | null;
  first_divergence: string | null;
  recommendation: string;
  disclaimer: string;
  rules_version: string;
}

export interface ProbeResult {
  output: ProbeOutput;
  // Tokens the user's wallet received in the simulated 1x buy (the basis for minOut).
  userBuyReceived: bigint | null;
  header: Header | null;
}

export const DISCLAIMER =
  "Consistent behavior in simulation is not a guarantee: owner actions (pausing, blacklisting, changing taxes), other traders and later pool changes are not simulated.";

interface Plan {
  id: string;
  label: string;
  kind: ScenarioKind;
  hold: string;
  holdSeconds: number;
  sender: Address;
  freshWallet: boolean;
  sizeFactor: number;
  amountWei: bigint;
  split: boolean;
}

interface Buy {
  ok: boolean;
  expected: bigint | null;
  received: bigint;
  error: string | null;
}

// Two deterministic throwaway addresses per token, so wallet-specific rules show up.
export function freshWallet(token: Address, index: number): Address {
  const hash = keccak256(encodePacked(["string", "address", "uint8"], ["multiverse.fresh", token, index]));
  return getAddress(`0x${hash.slice(-40)}`);
}

export function planScenarios(params: ProbeParams): Plan[] {
  const { wallet, amountWei, token } = params;
  const base = { sender: wallet, freshWallet: false, sizeFactor: 1, amountWei, split: false };
  const horizons = [...new Set(params.horizons)].sort((a, b) => HORIZON_SECONDS[a] - HORIZON_SECONDS[b]);
  const plans: Plan[] = [{ ...base, id: "now", label: "Buy, then sell everything in the next block", kind: "now", hold: "now", holdSeconds: 0 }];
  const horizonPlans: Plan[] = horizons.map((horizon) => ({
    ...base, id: `t_${horizon}`, label: `Buy, hold ${horizon}, then sell everything`, kind: "horizon", hold: horizon,
    holdSeconds: HORIZON_SECONDS[horizon],
  }));
  if (params.mode === "fast") {
    return [...plans, { ...base, id: "t_1h", label: "Buy, hold 1h, then sell everything", kind: "horizon", hold: "1h", holdSeconds: 3_600 }];
  }
  const freshC = horizons.includes("1h") ? { hold: "1h", holdSeconds: 3_600 } : { hold: "now", holdSeconds: 0 };
  return [
    ...plans,
    ...horizonPlans,
    { ...base, id: "size_quarter", label: "Buy a quarter of the size, sell everything next block", kind: "size", hold: "now", holdSeconds: 0, sizeFactor: 0.25, amountWei: amountWei / 4n },
    { ...base, id: "size_4x", label: "Buy 4x the size, sell everything next block", kind: "size", hold: "now", holdSeconds: 0, sizeFactor: 4, amountWei: amountWei * 4n },
    { ...base, id: "sequence", label: "Buy, sell half next block, then the other half a block later", kind: "sequence", hold: "now", holdSeconds: 0, split: true },
    { ...base, id: "wallet_b", label: "Same trade from a fresh wallet, sell next block", kind: "wallet", hold: "now", holdSeconds: 0, sender: freshWallet(token, 1), freshWallet: true },
    { ...base, id: "wallet_c", label: `Same trade from another fresh wallet, sell after ${freshC.hold === "now" ? "the next block" : "1h"}`, kind: "wallet", ...freshC, sender: freshWallet(token, 2), freshWallet: true },
  ];
}

export async function runProbe(params: ProbeParams, rpc: Rpc): Promise<ProbeResult> {
  const plans = planScenarios(params);
  const output: ProbeOutput = {
    token: { address: params.token, symbol_untrusted: "", decimals: null },
    venue: null,
    block: { number: null, timestamp: null, number_gap_limited: false },
    scenarios: [],
    flags: [],
    verdict: "INCOMPLETE",
    exit_horizon: null,
    first_divergence: null,
    recommendation: "",
    disclaimer: DISCLAIMER,
    rules_version: RULES.version,
  };
  const missing = (plan: Plan, error: string): Outcome => outcomeFor(plan, { simulated: false, error });

  // Pre-checks: one batch.
  let header: Header;
  let pair: Address;
  try {
    const [block, pairCall, decimalsCall, symbolCall] = await rpcBatch(rpc, [
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { method: "eth_call", params: [{ to: V2_FACTORY, data: encodeFunctionData({ abi: factoryAbi, functionName: "getPair", args: [params.token, WETH] }) }, "latest"] },
      { method: "eth_call", params: [{ to: params.token, data: encodeFunctionData({ abi: tokenAbi, functionName: "decimals" }) }, "latest"] },
      { method: "eth_call", params: [{ to: params.token, data: encodeFunctionData({ abi: tokenAbi, functionName: "symbol" }) }, "latest"] },
    ]);
    header = parseHeader(block?.result);
    if (typeof pairCall?.result !== "string") throw new Error("getPair failed");
    pair = getAddress(`0x${pairCall.result.slice(-40)}`);
    output.block.number = Number(header.number);
    output.block.timestamp = Number(header.timestamp);
    output.token.symbol_untrusted = decodeSymbol(symbolCall?.result);
    const decimals = typeof decimalsCall?.result === "string" && decimalsCall.result.length >= 66 ? Number(BigInt(decimalsCall.result.slice(0, 66))) : null;
    output.token.decimals = decimals !== null && decimals <= 255 ? decimals : null;
  } catch (error) {
    return finish(output, plans.map((plan) => missing(plan, `pre-check failed: ${(error as Error).message}`)), params, null, null);
  }

  if (pair === zeroAddress) {
    output.verdict = "UNSUPPORTED_VENUE";
    output.recommendation = "Not testable: this token has no Uniswap V2 WETH pair on Base, so Multiverse cannot simulate it and it must not be treated as safe.";
    output.first_divergence = null;
    return { output, userBuyReceived: null, header };
  }

  // Reserves run alongside Phase A.
  const reservesPromise = rpcCall(rpc, {
    method: "eth_call",
    params: [{ to: pair, data: encodeFunctionData({ abi: pairAbi, functionName: "getReserves" }) }, `0x${header.number.toString(16)}`],
  }).then((result) => {
    const [reserve0, reserve1] = decodeFunctionResult({ abi: pairAbi, functionName: "getReserves", data: result as Hex });
    return BigInt(WETH) < BigInt(params.token) ? reserve0 : reserve1;
  }).catch(() => null);

  // Phase A: one simulation per distinct sender and size, to learn what the buy delivers.
  const buyKey = (plan: Plan) => `${plan.sender}:${plan.amountWei}`;
  const buyPlans = [...new Map(plans.map((plan) => [buyKey(plan), plan])).values()];
  const firstBlock = (plan: Plan, calls: SimBlock["calls"]): SimBlock => ({
    number: header.number + 1n, time: header.timestamp + 2n, calls, fund: fundSender(plan.sender, plan.amountWei),
  });
  const buyDeadline = header.timestamp + 3_600n;
  const buys = new Map<string, Buy | Error>();
  await Promise.all(buyPlans.map(async (plan) => {
    const blocks = [firstBlock(plan, [
      balanceCall(plan.sender, params.token),
      quoteBuyCall(plan.sender, params.token, plan.amountWei),
      buyCall(plan.sender, params.token, plan.amountWei, 0n, buyDeadline),
      balanceCall(plan.sender, params.token),
    ])];
    try {
      const [block] = requestedBlocks(await rpcCall(rpc, simulateRequest(blocks, header)), blocks);
      const [before, quote, buy, after] = block?.calls ?? [];
      if (!buy) throw new Error("simulation returned no buy result");
      // Transfer logs first; the balance difference covers tokens with non-standard events.
      let received = sumTransfersTo(buy, params.token, plan.sender);
      const balanceBefore = decodeUint(before);
      const balanceAfter = decodeUint(after);
      if (received === 0n && callOk(buy) && balanceBefore !== null && balanceAfter !== null && balanceAfter > balanceBefore) {
        received = balanceAfter - balanceBefore;
      }
      buys.set(buyKey(plan), { ok: callOk(buy), expected: decodeQuote(quote), received, error: callOk(buy) ? null : revertReason(buy) });
    } catch (error) {
      buys.set(buyKey(plan), error as Error);
    }
  }));

  // Phase B: one simulation per scenario: buy + approve, then sell after the hold.
  let gapLimited = false;
  const outcomes = await Promise.all(plans.map(async (plan): Promise<Outcome> => {
    const buy = buys.get(buyKey(plan));
    if (!buy || buy instanceof Error) return missing(plan, `buy simulation failed: ${buy?.message ?? "no result"}`);
    const buyTax = taxPct(buy.received, buy.expected);
    if (!buy.ok) return outcomeFor(plan, { buyOk: false, error: buy.error });
    if (buy.received === 0n) return outcomeFor(plan, { buyOk: true, buyTaxPct: 100, error: "the buy delivered no tokens" });

    const portions = plan.split ? [buy.received / 2n, buy.received - buy.received / 2n] : [buy.received];
    const build = (gapBlocks: bigint): SimBlock[] => {
      const sellTime = header.timestamp + 2n + (plan.holdSeconds > 0 ? BigInt(plan.holdSeconds) : 2n);
      const deadline = sellTime + 3_600n;
      const blocks: SimBlock[] = [firstBlock(plan, [buyCall(plan.sender, params.token, plan.amountWei, 0n, buyDeadline), approveCall(plan.sender, params.token)])];
      portions.forEach((amount, index) => {
        blocks.push({
          number: header.number + 1n + gapBlocks + BigInt(index),
          time: sellTime + 2n * BigInt(index),
          calls: [quoteSellCall(plan.sender, params.token, amount), sellCall(plan.sender, params.token, amount, deadline)],
        });
      });
      return blocks;
    };
    const wantedGap = plan.holdSeconds > 0 ? BigInt(Math.min(Math.floor(plan.holdSeconds / 2), MAX_SIM_BLOCK_GAP)) : 1n;

    let blocks = build(wantedGap);
    let result: unknown;
    try {
      result = await rpcCall(rpc, simulateRequest(blocks, header));
    } catch (error) {
      const rejected = (error as { kind?: string }).kind === "rpc";
      if (!rejected || wantedGap === 1n) return missing(plan, `sell simulation failed: ${(error as Error).message}`);
      // The RPC refused the block-number gap: keep the time jump, advance one block.
      blocks = build(1n);
      try {
        result = await rpcCall(rpc, simulateRequest(blocks, header));
        gapLimited = true;
      } catch (retryError) {
        return missing(plan, `sell simulation failed: ${(retryError as Error).message}`);
      }
    }

    const [buyBlock, ...sellBlocks] = requestedBlocks(result, blocks);
    const [buyAgain, approve] = buyBlock?.calls ?? [];
    if (!buyAgain || sellBlocks.some((block) => !block?.calls?.length)) return missing(plan, "simulation returned incomplete blocks");
    if (!callOk(buyAgain)) return outcomeFor(plan, { buyOk: false, error: revertReason(buyAgain) });
    if (!callOk(approve)) return outcomeFor(plan, { buyOk: true, buyTaxPct: buyTax, error: `approve reverted: ${revertReason(approve)}`, failedSellStep: 1 });

    let expected = 0n;
    let received = 0n;
    let expectedKnown = true;
    for (const [index, block] of sellBlocks.entries()) {
      const [quote, sell] = block!.calls as [SimCallResult, SimCallResult];
      if (!callOk(sell)) {
        return outcomeFor(plan, { buyOk: true, buyTaxPct: buyTax, error: revertReason(sell), failedSellStep: index + 1 });
      }
      const quoted = decodeQuote(quote);
      if (quoted === null) expectedKnown = false;
      expected += quoted ?? 0n;
      received += sumTransfersTo(sell, WETH, plan.sender);
    }
    return outcomeFor(plan, {
      buyOk: true, buyTaxPct: buyTax, sellOk: true,
      sellTaxPct: expectedKnown ? taxPct(received, expected) : null,
      roundTripLossPct: lossPct(received, plan.amountWei),
    });
  }));

  output.block.number_gap_limited = gapLimited;
  const reserve = await reservesPromise;
  output.venue = { kind: "uniswap_v2", pair, reserve_weth_eth: reserve === null ? "unknown" : formatEther(reserve) };
  const userBuy = buys.get(`${params.wallet}:${params.amountWei}`);
  return finish(output, outcomes, params, reserve, header, userBuy && !(userBuy instanceof Error) && userBuy.ok ? userBuy.received : null);
}

function outcomeFor(plan: Plan, values: Partial<Outcome>): Outcome {
  return {
    id: plan.id, label: plan.label, kind: plan.kind, hold: plan.hold, holdSeconds: plan.holdSeconds, sizeFactor: plan.sizeFactor,
    sizeEth: formatEther(plan.amountWei), freshWallet: plan.freshWallet,
    simulated: true, buyOk: false, buyTaxPct: null, sellOk: false, sellTaxPct: null, roundTripLossPct: null, error: null, failedSellStep: null,
    sender: plan.sender,
    ...values,
  };
}

function finish(output: ProbeOutput, outcomes: Outcome[], params: ProbeParams, reserve: bigint | null, header: Header | null, userBuyReceived: bigint | null = null): ProbeResult {
  const evaluation = evaluate(outcomes, { reserveWethWei: reserve, maxTaxPct: params.maxTaxPct });
  output.scenarios = outcomes.map((outcome) => ({
    id: outcome.id,
    label: outcome.label,
    hold: outcome.hold,
    size_eth: outcome.sizeEth,
    sender: outcome.sender,
    simulated: outcome.simulated,
    buy_ok: outcome.buyOk,
    buy_tax_pct: outcome.buyTaxPct,
    sell_ok: outcome.sellOk,
    sell_tax_pct: outcome.sellTaxPct,
    round_trip_loss_pct: outcome.roundTripLossPct,
    error: outcome.error,
  }));
  output.flags = evaluation.flags;
  output.verdict = evaluation.verdict;
  output.exit_horizon = evaluation.exitHorizon;
  output.first_divergence = evaluation.divergence;
  output.recommendation = recommend(output, evaluation.largestSizeOk, params);
  return { output, userBuyReceived, header };
}

function recommend(output: ProbeOutput, largestSizeOk: number | null, params: ProbeParams): string {
  const amount = formatEther(params.amountWei);
  const done = output.scenarios.filter((scenario) => scenario.simulated).length;
  const now = output.scenarios.find((scenario) => scenario.id === "now");
  switch (output.verdict) {
    case "CONSISTENT":
      return `Consistent in all ${done} universes (buy tax ${pct(now?.buy_tax_pct ?? null)}, sell tax ${pct(now?.sell_tax_pct ?? null)}, exit tested up to ${output.exit_horizon}): buying ${amount} ETH matches the simulation; multiverse_buy proposes exactly this trade for approval.`;
    case "CAUTION": {
      const size = output.flags.includes("SIZE_DEPENDENT") && largestSizeOk !== null
        ? ` Largest size that behaved normally: ${formatEther((params.amountWei * BigInt(Math.round(largestSizeOk * 100))) / 100n)} ETH.` : "";
      return `Caution: ${output.first_divergence}. Ask the user before buying; multiverse_buy requires accept_caution=true.${size}`;
    }
    case "BLOCK":
      return `Do not buy: ${output.first_divergence}.`;
    case "INCOMPLETE":
      return "Do not buy on this result: some universes could not be simulated (RPC error or time budget); run the probe again.";
    default:
      return output.recommendation;
  }
}

export function summarize(output: ProbeOutput, amountWei: bigint): string {
  const symbol = output.token.symbol_untrusted ? ` (symbol, untrusted: "${output.token.symbol_untrusted.replace(/["\\]/g, "")}")` : "";
  const done = output.scenarios.filter((scenario) => scenario.simulated).length;
  const now = output.scenarios.find((scenario) => scenario.id === "now");
  const lines = [
    `Multiverse verdict: ${output.verdict}${output.flags.length ? ` [${output.flags.join(", ")}]` : ""}`,
    `Token ${output.token.address}${symbol}; ${output.venue ? `Uniswap V2 pool ${output.venue.pair} with ${output.venue.reserve_weth_eth} WETH` : "no supported pool"}.`,
  ];
  if (output.scenarios.length) {
    lines.push(`Simulated ${done}/${output.scenarios.length} universes for ${formatEther(amountWei)} ETH at Base block ${output.block.number ?? "unknown"}.`);
    lines.push(`Now: buy tax ${pct(now?.buy_tax_pct ?? null)}, sell tax ${pct(now?.sell_tax_pct ?? null)}, round trip ${pct(now?.round_trip_loss_pct ?? null)}; exit horizon: ${output.exit_horizon ?? "none"}.`);
  }
  lines.push(`First divergence: ${output.first_divergence ?? "none"}.`);
  lines.push(`Recommendation: ${output.recommendation}`);
  lines.push(`Note: ${output.disclaimer}`);
  return lines.join("\n");
}
