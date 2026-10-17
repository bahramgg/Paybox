import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, hexToString, maxUint256, type Address, type Hex } from "viem";

import { BALANCE_BUFFER_WEI, routerAbi, SIM_GAS, SIM_PRIORITY_FEE_WEI, tokenAbi, TRANSFER_TOPIC, V2_ROUTER, WETH } from "./constants.js";
import { untrustedText } from "./text.js";

export interface Header {
  number: bigint;
  timestamp: bigint;
  baseFee: bigint;
  miner: Address;
}

export interface SimCall {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
}

export interface SimBlock {
  number: bigint;
  time: bigint;
  calls: SimCall[];
  fund?: { address: Address; balance: bigint };
}

export interface SimLog {
  address?: string;
  topics?: string[];
  data?: string;
}

export interface SimCallResult {
  status?: string;
  returnData?: string;
  logs?: SimLog[];
  error?: { code?: number; message?: string; data?: string };
}

export interface SimBlockResult {
  number?: string;
  calls?: SimCallResult[];
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

export function parseHeader(block: unknown): Header {
  const value = block as Record<string, string | undefined>;
  if (!value?.number || !value.timestamp || !value.miner) throw new Error("latest block header is incomplete");
  return {
    number: BigInt(value.number),
    timestamp: BigInt(value.timestamp),
    baseFee: BigInt(value.baseFeePerGas ?? "0x0"),
    miner: value.miner as Address,
  };
}

// Every simulated block reuses the real header's fee recipient and base fee; only number and time move.
export function simulateRequest(blocks: SimBlock[], header: Header) {
  const maxFeePerGas = header.baseFee * 2n + SIM_PRIORITY_FEE_WEI;
  return {
    method: "eth_simulateV1",
    params: [
      {
        blockStateCalls: blocks.map((block) => ({
          blockOverrides: {
            number: hex(block.number),
            time: hex(block.time),
            baseFeePerGas: hex(header.baseFee),
            feeRecipient: header.miner,
          },
          ...(block.fund ? { stateOverrides: { [block.fund.address]: { balance: hex(block.fund.balance) } } } : {}),
          calls: block.calls.map((call) => ({
            from: call.from,
            to: call.to,
            data: call.data,
            gas: hex(SIM_GAS),
            maxFeePerGas: hex(maxFeePerGas),
            maxPriorityFeePerGas: hex(SIM_PRIORITY_FEE_WEI),
            ...(call.value ? { value: hex(call.value) } : {}),
          })),
        })),
        validation: false,
      },
      hex(header.number),
    ],
  };
}

export const fundSender = (sender: Address, amountWei: bigint) => ({ address: sender, balance: amountWei + BALANCE_BUFFER_WEI });

export const quoteBuyCall = (sender: Address, token: Address, amountWei: bigint): SimCall => ({
  from: sender, to: V2_ROUTER,
  data: encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [amountWei, [WETH, token]] }),
});

export const buyCall = (sender: Address, token: Address, amountWei: bigint, minOut: bigint, deadline: bigint): SimCall => ({
  from: sender, to: V2_ROUTER, value: amountWei,
  data: buyCalldata(token, sender, minOut, deadline),
});

export function buyCalldata(token: Address, recipient: Address, minOut: bigint, deadline: bigint): Hex {
  return encodeFunctionData({
    abi: routerAbi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
    args: [minOut, [WETH, token], recipient, deadline],
  });
}

export const balanceCall = (sender: Address, token: Address): SimCall => ({
  from: sender, to: token,
  data: encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [sender] }),
});

export const approveCall = (sender: Address, token: Address): SimCall => ({
  from: sender, to: token,
  data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [V2_ROUTER, maxUint256] }),
});

export const quoteSellCall = (sender: Address, token: Address, amount: bigint): SimCall => ({
  from: sender, to: V2_ROUTER,
  data: encodeFunctionData({ abi: routerAbi, functionName: "getAmountsOut", args: [amount, [token, WETH]] }),
});

export const sellCall = (sender: Address, token: Address, amount: bigint, deadline: bigint): SimCall => ({
  from: sender, to: V2_ROUTER,
  data: encodeFunctionData({
    abi: routerAbi, functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens",
    args: [amount, 0n, [token, WETH], sender, deadline],
  }),
});

export const callOk = (call: SimCallResult | undefined) => call?.status === "0x1";

// Last element of getAmountsOut, or null when the quote reverted.
export function decodeQuote(call: SimCallResult | undefined): bigint | null {
  if (!callOk(call) || !call?.returnData) return null;
  try {
    const amounts = decodeFunctionResult({ abi: routerAbi, functionName: "getAmountsOut", data: call.returnData as Hex });
    return amounts.length ? (amounts[amounts.length - 1] ?? null) : null;
  } catch {
    return null;
  }
}

export function decodeUint(call: SimCallResult | undefined): bigint | null {
  if (!callOk(call) || !call?.returnData || call.returnData.length < 66) return null;
  try {
    return BigInt(call.returnData.slice(0, 66));
  } catch {
    return null;
  }
}

export function sumTransfersTo(call: SimCallResult | undefined, asset: Address, recipient: Address): bigint {
  const assetLower = asset.toLowerCase();
  const recipientTopic = `0x${"0".repeat(24)}${recipient.slice(2).toLowerCase()}`;
  let total = 0n;
  for (const log of call?.logs ?? []) {
    if (log.address?.toLowerCase() !== assetLower || log.topics?.length !== 3) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics[2]?.toLowerCase() !== recipientTopic) continue;
    if (log.data && /^0x[0-9a-fA-F]{64}/.test(log.data)) total += BigInt(log.data.slice(0, 66));
  }
  return total;
}

export function revertReason(call: SimCallResult | undefined): string {
  if (!call) return "no result";
  const data = (call.returnData && call.returnData !== "0x" ? call.returnData : call.error?.data) ?? "";
  try {
    if (data.startsWith("0x08c379a0")) {
      const [message] = decodeAbiParameters([{ type: "string" }], `0x${data.slice(10)}` as Hex);
      return untrustedText(message, 120) || "reverted";
    }
    if (data.startsWith("0x4e487b71")) {
      const [code] = decodeAbiParameters([{ type: "uint256" }], `0x${data.slice(10)}` as Hex);
      return `panic 0x${code.toString(16)}`;
    }
  } catch {
    // fall through to the generic message
  }
  if (/^0x[0-9a-fA-F]{8}/.test(data)) return `custom error ${data.slice(0, 10)}`;
  if (call.error?.message) return untrustedText(call.error.message, 120);
  return "reverted";
}

// symbol() may return a string or a legacy bytes32.
export function decodeSymbol(result: unknown): string {
  if (typeof result !== "string" || result === "0x") return "";
  try {
    return untrustedText(decodeFunctionResult({ abi: tokenAbi, functionName: "symbol", data: result as Hex }), 32);
  } catch {
    if (result.length === 66) {
      try {
        return untrustedText(hexToString(result as Hex).replace(/\0+$/, ""), 32);
      } catch {
        return "";
      }
    }
    return "";
  }
}

// Simulated responses include the empty filler blocks between requested blocks; keep only ours.
export function requestedBlocks(result: unknown, blocks: SimBlock[]): Array<SimBlockResult | undefined> {
  const list = Array.isArray(result) ? (result as SimBlockResult[]) : [];
  return blocks.map((block) => list.find((entry) => entry.number !== undefined && BigInt(entry.number) === block.number));
}
