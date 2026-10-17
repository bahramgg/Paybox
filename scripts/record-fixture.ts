// Records a live probe's JSON-RPC traffic as a replayable test fixture (not bundled).
// Usage: pnpm exec tsx scripts/record-fixture.ts <name> <token> [amount_eth] [mode]
import { mkdirSync, writeFileSync } from "node:fs";
import { getAddress } from "viem";

import { DEFAULT_HORIZONS, RPC_URLS, TOOL_BUDGET_MS } from "../src/constants.js";
import { runProbe, type ProbeParams } from "../src/engine.js";
import { atomicAmount } from "../src/paybox.js";
import { RpcPool, type Rpc } from "../src/rpc.js";

const [name, token, amount = "0.002", mode = "full"] = process.argv.slice(2);
if (!name || !token) throw new Error("usage: record-fixture.ts <name> <token> [amount_eth] [mode]");

// Simulated responses carry 200 empty filler blocks and full headers; keep only what the engine reads.
function slim(response: unknown): unknown {
  const value = response as { result?: unknown };
  if (!Array.isArray(value?.result) || !value.result.every((block) => block && typeof block === "object" && "calls" in block)) return response;
  return {
    ...value,
    result: (value.result as Array<{ number: string; calls: unknown[] }>)
      .filter((block) => block.calls.length > 0)
      .map((block) => ({ number: block.number, calls: block.calls })),
  };
}

const pool = new RpcPool(RPC_URLS, Date.now() + TOOL_BUDGET_MS);
const exchanges: Array<{ body: unknown; response: unknown }> = [];
const recorder: Rpc = {
  async send(body) {
    const response = await pool.send(body);
    exchanges.push({ body, response: slim(response) });
    return response;
  },
};

const params: ProbeParams = {
  token: getAddress(token),
  amountWei: BigInt(atomicAmount(amount, 18)),
  wallet: getAddress("0x8ba1f109551bD432803012645Ac136ddd64DBA72"),
  horizons: DEFAULT_HORIZONS,
  maxTaxPct: 15,
  mode: mode === "fast" ? "fast" : "full",
};
const result = await runProbe(params, recorder);
mkdirSync("test/fixtures", { recursive: true });
writeFileSync(`test/fixtures/${name}.json`, `${JSON.stringify({
  params: { ...params, amountWei: params.amountWei.toString() },
  expected: { output: result.output, userBuyReceived: result.userBuyReceived?.toString() ?? null },
  exchanges,
})}\n`);
console.log(`${name}: ${result.output.verdict} [${result.output.flags.join(", ")}], ${exchanges.length} exchanges`);
