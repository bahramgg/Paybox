import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, maxUint256, parseEther, type Address } from "viem";

import { factoryAbi, pairAbi, routerAbi, tokenAbi, TRANSFER_TOPIC, V2_ROUTER, WETH } from "../src/constants.js";
import { freshWallet, planScenarios } from "../src/engine.js";
import {
  approveCall, buyCalldata, decodeQuote, decodeSymbol, quoteSellCall, requestedBlocks, revertReason, sellCall,
  simulateRequest, sumTransfersTo, type Header,
} from "../src/simulate.js";
import { lossPct, taxPct, untrustedText } from "../src/text.js";

const TOKEN: Address = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b";
const USER: Address = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const header: Header = { number: 1000n, timestamp: 1_800_000_000n, baseFee: 5_000_000n, miner: "0x4200000000000000000000000000000000000011" };

test("encoding: function selectors match the Uniswap V2 and ERC-20 ABIs", () => {
  const selector = (data: string) => data.slice(0, 10);
  assert.equal(selector(encodeFunctionData({ abi: factoryAbi, functionName: "getPair", args: [TOKEN, WETH] })), "0xe6a43905");
  assert.equal(selector(encodeFunctionData({ abi: pairAbi, functionName: "getReserves" })), "0x0902f1ac");
  assert.equal(selector(encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [1n, [WETH, TOKEN]] })), "0xd06ca61f");
  assert.equal(selector(buyCalldata(TOKEN, USER, 1n, 2n)), "0xb6f9de95");
  assert.equal(selector(sellCall(USER, TOKEN, 1n, 2n).data), "0x5c11d795");
  assert.equal(selector(approveCall(USER, TOKEN).data), "0x095ea7b3");
  assert.equal(selector(encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [USER] })), "0x70a08231");
  assert.equal(selector(encodeFunctionData({ abi: tokenAbi, functionName: "decimals" })), "0x313ce567");
  assert.equal(selector(encodeFunctionData({ abi: tokenAbi, functionName: "symbol" })), "0x95d89b41");
});

test("encoding: the proposed buy pays the user wallet through WETH -> token", () => {
  const { functionName, args } = decodeFunctionData({ abi: routerAbi, data: buyCalldata(TOKEN, USER, 123n, 456n) });
  assert.equal(functionName, "swapExactETHForTokensSupportingFeeOnTransferTokens");
  assert.deepEqual(args, [123n, [WETH, TOKEN], USER, 456n]);
});

test("encoding: sell and approve target the router with the full amount", () => {
  const sell = decodeFunctionData({ abi: routerAbi, data: sellCall(USER, TOKEN, 999n, 77n).data });
  assert.deepEqual(sell.args, [999n, 0n, [TOKEN, WETH], USER, 77n]);
  const approve = decodeFunctionData({ abi: tokenAbi, data: approveCall(USER, TOKEN).data });
  assert.deepEqual(approve.args, [V2_ROUTER, maxUint256]);
  assert.equal(quoteSellCall(USER, TOKEN, 5n).to, V2_ROUTER);
});

test("encoding: simulated blocks reuse the real header and fund the sender", () => {
  const request = simulateRequest([
    { number: 1001n, time: 1_800_000_002n, calls: [approveCall(USER, TOKEN)], fund: { address: USER, balance: parseEther("0.052") } },
    { number: 1201n, time: 1_800_003_602n, calls: [sellCall(USER, TOKEN, 1n, 2n)] },
  ], header);
  assert.equal(request.method, "eth_simulateV1");
  const [options, blockTag] = request.params as [{ blockStateCalls: any[]; validation: boolean }, string];
  assert.equal(blockTag, "0x3e8");
  assert.equal(options.validation, false);
  assert.deepEqual(options.blockStateCalls[0].blockOverrides, { number: "0x3e9", time: "0x6b49d202", baseFeePerGas: "0x4c4b40", feeRecipient: header.miner });
  assert.deepEqual(options.blockStateCalls[0].stateOverrides, { [USER]: { balance: `0x${parseEther("0.052").toString(16)}` } });
  assert.equal(options.blockStateCalls[1].blockOverrides.number, "0x4b1");
  assert.equal(options.blockStateCalls[1].stateOverrides, undefined);
  const call = options.blockStateCalls[0].calls[0];
  assert.equal(call.maxFeePerGas, "0xa7d8c0"); // 2 x base fee + 0.001 gwei tip
  assert.equal(call.maxPriorityFeePerGas, "0xf4240");
});

test("scenarios: full plan matches the spec and fast plan is now + 1h", () => {
  const params = { token: TOKEN, amountWei: parseEther("0.002"), wallet: USER, horizons: ["24h", "10m", "1h"] as const, maxTaxPct: 15 };
  const full = planScenarios({ ...params, horizons: [...params.horizons], mode: "full" });
  assert.deepEqual(full.map((plan) => plan.id), ["now", "t_10m", "t_1h", "t_24h", "size_quarter", "size_4x", "sequence", "wallet_b", "wallet_c"]);
  assert.equal(full.find((plan) => plan.id === "size_4x")!.amountWei, parseEther("0.008"));
  assert.equal(full.find((plan) => plan.id === "wallet_c")!.holdSeconds, 3_600);
  assert.notEqual(freshWallet(TOKEN, 1), freshWallet(TOKEN, 2));
  assert.equal(freshWallet(TOKEN, 1), freshWallet(TOKEN, 1));
  const fast = planScenarios({ ...params, horizons: ["24h"], mode: "fast" });
  assert.deepEqual(fast.map((plan) => plan.id), ["now", "t_1h"]);
  const noHour = planScenarios({ ...params, horizons: ["10m"], mode: "full" });
  assert.equal(noHour.find((plan) => plan.id === "wallet_c")!.holdSeconds, 0);
});

const pad = (address: string) => `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}`;
const amount = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}`;

test("parsing: sums only Transfer logs of the asset to the recipient", () => {
  const call = {
    status: "0x1",
    logs: [
      { address: TOKEN, topics: [TRANSFER_TOPIC, pad(V2_ROUTER), pad(USER)], data: amount(700n) },
      { address: TOKEN.toLowerCase(), topics: [TRANSFER_TOPIC, pad(V2_ROUTER), pad(USER)], data: amount(300n) },
      { address: TOKEN, topics: [TRANSFER_TOPIC, pad(USER), pad(V2_ROUTER)], data: amount(5n) },
      { address: WETH, topics: [TRANSFER_TOPIC, pad(V2_ROUTER), pad(USER)], data: amount(9n) },
      { address: TOKEN, topics: [TRANSFER_TOPIC], data: "0x" },
    ],
  };
  assert.equal(sumTransfersTo(call, TOKEN, USER), 1000n);
  assert.equal(sumTransfersTo(call, WETH, USER), 9n);
  assert.equal(sumTransfersTo(undefined, WETH, USER), 0n);
});

test("parsing: quotes, reverts and symbols", () => {
  const quote = { status: "0x1", returnData: encodeAbiParameters([{ type: "uint256[]" }], [[10n, 20n]]) };
  assert.equal(decodeQuote(quote), 20n);
  assert.equal(decodeQuote({ status: "0x0", returnData: "0x" }), null);

  const errorString = `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["TRANSFER_FROM_FAILED"]).slice(2)}`;
  assert.equal(revertReason({ status: "0x0", returnData: errorString }), "TRANSFER_FROM_FAILED");
  const panic = `0x4e487b71${encodeAbiParameters([{ type: "uint256" }], [0x11n]).slice(2)}`;
  assert.equal(revertReason({ status: "0x0", returnData: panic }), "panic 0x11");
  assert.equal(revertReason({ status: "0x0", returnData: "0xdeadbeef" }), "custom error 0xdeadbeef");
  assert.equal(revertReason({ status: "0x0", returnData: "0x", error: { message: "execution reverted" } }), "execution reverted");
  assert.equal(revertReason({ status: "0x0" }), "reverted");
  const long = `0x08c379a0${encodeAbiParameters([{ type: "string" }], ["x".repeat(500)]).slice(2)}`;
  assert.equal(revertReason({ status: "0x0", returnData: long }).length, 120);

  assert.equal(decodeSymbol(encodeAbiParameters([{ type: "string" }], ["VIRTUAL"])), "VIRTUAL");
  assert.equal(decodeSymbol(`0x${Buffer.from("MKR").toString("hex").padEnd(64, "0")}`), "MKR");
  assert.equal(decodeSymbol("0x"), "");
  assert.equal(decodeSymbol(encodeAbiParameters([{ type: "string" }], ["A‮B\nC\u0000" + "Z".repeat(80)])).length, 32);
});

test("parsing: filler blocks are skipped when matching requested blocks", () => {
  const blocks = [{ number: 11n, time: 0n, calls: [] }, { number: 211n, time: 0n, calls: [] }];
  const result = [{ number: "0xb", calls: [{ status: "0x1" }] }, { number: "0xc", calls: [] }, { number: "0xd3", calls: [{ status: "0x0" }] }];
  const [first, second] = requestedBlocks(result, blocks);
  assert.equal(first?.calls?.[0]?.status, "0x1");
  assert.equal(second?.calls?.[0]?.status, "0x0");
  assert.deepEqual(requestedBlocks(null, blocks), [undefined, undefined]);
});

test("math: tax and round-trip percentages", () => {
  assert.equal(taxPct(94n, 100n), 6);
  assert.equal(taxPct(101n, 100n), 0);
  assert.equal(taxPct(1n, 0n), null);
  assert.equal(taxPct(0n, 100n), 100);
  assert.equal(lossPct(994n, 1000n), 0.6);
  assert.equal(lossPct(1010n, 1000n), -1);
  assert.equal(untrustedText("  a\u0007b​ c  ", 32), "ab c");
});
