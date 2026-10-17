import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { formatEther, getAddress, type Address } from "viem";
import * as z from "zod/v4";

import { ABOUT } from "./about.js";
import { CHAINS, DEFAULT_CHAIN, DEFAULT_HORIZONS, TOOL_BUDGET_MS, type ChainKey } from "./constants.js";
import { runProbe, summarize, type ProbeParams } from "./engine.js";
import { atomicAmount, proposeEvm } from "./paybox.js";
import { RpcPool } from "./rpc.js";
import { RULES } from "./rules.js";
import { aboutOutput, buyInput, buyOutput, probeInput, probeOutput } from "./schemas.js";
import { buyCalldata } from "./simulate.js";

const PROTOCOL_VERSION = "2026-07-28";

const pool = (chain: ChainKey) => new RpcPool(CHAINS[chain].rpcUrls, Date.now() + TOOL_BUDGET_MS);

function createServer() {
  const server = new McpServer(
    { name: "multiverse", version: "0.1.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] },
  );

  server.registerTool(
    "multiverse_probe",
    {
      title: "Multiverse probe",
      description:
        "Simulates a planned token buy and sell on Base, Ethereum or Arbitrum across hold times, trade sizes, sell order and wallets, and reports whether the token behaves the same in every case. Read-only.",
      inputSchema: probeInput,
      outputSchema: probeOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const chain = input.chain ?? DEFAULT_CHAIN;
      const params: ProbeParams = {
        token: getAddress(input.token),
        amountWei: BigInt(atomicAmount(input.amount_eth, 18)),
        wallet: getAddress(input.wallet),
        horizons: input.horizons ?? DEFAULT_HORIZONS,
        maxTaxPct: input.max_tax_pct ?? RULES.defaultMaxTaxPct,
        mode: "full",
        chain,
      };
      const { output } = await runProbe(params, pool(chain));
      return { content: [{ type: "text" as const, text: summarize(output, params.amountWei) }], structuredContent: output };
    },
  );

  server.registerTool(
    "multiverse_buy",
    {
      title: "Multiverse buy proposal",
      description:
        "Re-simulates the immediate and 1-hour universes for this exact buy and, unless the result is BLOCK, UNSUPPORTED_VENUE, INCOMPLETE or an unaccepted CAUTION, returns one unsigned Uniswap V2 buy on the selected chain matching the simulated trade for PayBox approval.",
      inputSchema: buyInput,
      outputSchema: buyOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const chainKey = input.chain ?? DEFAULT_CHAIN;
      const chain = CHAINS[chainKey];
      const token = getAddress(input.token);
      const wallet = getAddress(input.wallet);
      const amountWei = BigInt(atomicAmount(input.amount_eth, 18));
      const slippage = input.max_slippage_bps ?? 300;
      const { output, userBuyReceived, header } = await runProbe(
        { token, amountWei, wallet, horizons: ["1h"], maxTaxPct: RULES.defaultMaxTaxPct, mode: "fast", chain: chainKey },
        pool(chainKey),
      );
      const buy = {
        proposed: false, reason: "", amount_wei: amountWei.toString(), simulated_tokens_out: userBuyReceived?.toString() ?? null,
        min_tokens_out: null as string | null, max_slippage_bps: slippage, deadline: null as number | null,
      };
      const summary = summarize(output, amountWei);

      const allowed = output.verdict === "CONSISTENT" || (output.verdict === "CAUTION" && input.accept_caution === true);
      if (!allowed || userBuyReceived === null || userBuyReceived === 0n) {
        buy.reason = output.verdict === "CAUTION"
          ? "CAUTION verdict: no proposal unless the user accepts the caution (accept_caution=true)."
          : `${output.verdict} verdict: no proposal.`;
        return { content: [{ type: "text" as const, text: `${summary}\nNo transaction proposed: ${buy.reason}` }], structuredContent: { ...output, buy } };
      }

      const minOut = (userBuyReceived * BigInt(10_000 - slippage)) / 10_000n;
      const nowSeconds = Math.max(Math.floor(Date.now() / 1000), Number(header?.timestamp ?? 0));
      const deadline = nowSeconds + 300;
      const proposal = proposeEvm({
        chain: chain.caip,
        to: chain.router,
        value: amountWei.toString(),
        data: buyCalldata(token, wallet as Address, minOut, BigInt(deadline), chain),
      });
      Object.assign(buy, { proposed: true, reason: "Simulation allowed this exact trade.", min_tokens_out: minOut.toString(), deadline });
      const proposalText = `Proposed one unsigned call on ${chain.name}: Uniswap V2 router ${chain.router}, swap ${formatEther(amountWei)} ETH for at least ${minOut} raw token units (simulated ${userBuyReceived}, ${slippage} bps slippage) to ${wallet}, deadline ${deadline}. ${proposal.content[0]!.text}`;
      return {
        content: [{ type: "text" as const, text: `${summary}\n${proposalText}` }],
        structuredContent: { ...output, buy, ...proposal.structuredContent },
      };
    },
  );

  server.registerTool(
    "multiverse_about",
    {
      title: "About Multiverse",
      description: "Returns Multiverse's scenario list, owner rules and thresholds, verdict meanings and limitations. Static; no network access.",
      inputSchema: z.object({}).strict(),
      outputSchema: aboutOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => ({
      content: [{ type: "text" as const, text: `Multiverse ${ABOUT.rules_version}: ${ABOUT.scenarios.length} scenario groups, ${ABOUT.rules.length} rules. ${ABOUT.disclaimer}` }],
      structuredContent: ABOUT,
    }),
  );

  return server;
}

serveStdio(createServer, { legacy: "reject" });
