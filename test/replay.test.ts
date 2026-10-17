import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CHAINS } from "../src/constants.js";
import { runProbe, summarize, type ProbeParams } from "../src/engine.js";
import { type Rpc } from "../src/rpc.js";
import { probeOutput } from "../src/schemas.js";

interface Fixture {
  params: Omit<ProbeParams, "amountWei"> & { amountWei: string };
  expected: { output: unknown; userBuyReceived: string | null };
  exchanges: Array<{ body: unknown; response: unknown }>;
}

function load(name: string) {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
  const responses = new Map(fixture.exchanges.map((exchange) => [JSON.stringify(exchange.body), exchange.response]));
  const replay: Rpc = {
    async send(body) {
      const response = responses.get(JSON.stringify(body));
      if (response === undefined) throw new Error("request not in fixture");
      return structuredClone(response);
    },
  };
  return { fixture, replay, params: { ...fixture.params, amountWei: BigInt(fixture.params.amountWei) } as ProbeParams };
}

for (const name of ["virtual_consistent", "dcplus_taxed", "temo_buy_fails", "unsupported_venue", "virtual_fast", "ethereum_pepe"]) {
  test(`replay: ${name} reproduces the recorded result`, async () => {
    const { fixture, replay, params } = load(name);
    const result = await runProbe(params, replay);
    assert.deepEqual(result.output, fixture.expected.output);
    assert.equal(result.userBuyReceived?.toString() ?? null, fixture.expected.userBuyReceived);
    probeOutput.parse(result.output);
    const text = summarize(result.output, params.amountWei).split("\n");
    assert.ok(text.length >= 4 && text.length <= 8, `summary has ${text.length} lines`);
  });
}

test("replay: VIRTUAL behaves the same in all nine universes", async () => {
  const { replay, params } = load("virtual_consistent");
  const { output } = await runProbe(params, replay);
  assert.equal(output.verdict, "CONSISTENT");
  assert.equal(output.scenarios.length, 9);
  assert.ok(output.scenarios.every((scenario) => scenario.simulated && scenario.buy_ok && scenario.sell_ok));
  assert.ok(output.scenarios.every((scenario) => scenario.sell_tax_pct === 0 && scenario.buy_tax_pct === 0));
  assert.equal(output.exit_horizon, "24h");
});

test("replay: DCPLUS measures its 6% buy and sell tax", async () => {
  const { replay, params } = load("dcplus_taxed");
  const { output } = await runProbe(params, replay);
  const now = output.scenarios.find((scenario) => scenario.id === "now")!;
  assert.equal(now.buy_tax_pct, 6);
  assert.equal(now.sell_tax_pct, 6);
  assert.ok(now.round_trip_loss_pct! > 11 && now.round_trip_loss_pct! < 13);
});

test("replay: a drained pool blocks because the buy reverts", async () => {
  const { replay, params } = load("temo_buy_fails");
  const { output } = await runProbe(params, replay);
  assert.equal(output.verdict, "BLOCK");
  assert.deepEqual(output.flags, ["BUY_FAILS_NOW", "THIN_LIQUIDITY"]);
  assert.match(output.first_divergence!, /buy itself reverts/);
});

test("replay: a token without a V2 WETH pair is unsupported", async () => {
  const { replay, params } = load("unsupported_venue");
  const { output } = await runProbe(params, replay);
  assert.equal(output.verdict, "UNSUPPORTED_VENUE");
  assert.equal(output.venue, null);
  assert.deepEqual(output.scenarios, []);
});

test("replay: an RPC outage yields INCOMPLETE instead of an error", async () => {
  const { params } = load("virtual_consistent");
  const down: Rpc = { send: async () => { throw new Error("connect ECONNREFUSED"); } };
  const { output } = await runProbe(params, down);
  assert.equal(output.verdict, "INCOMPLETE");
  assert.ok(output.scenarios.every((scenario) => !scenario.simulated));
  probeOutput.parse(output);
});

test("replay: losing Phase B for one universe yields INCOMPLETE", async () => {
  const { replay, params } = load("virtual_consistent");
  const flaky: Rpc = {
    async send(body) {
      const blocks = (body as { params?: Array<{ blockStateCalls?: unknown[] }> }).params?.[0]?.blockStateCalls;
      if (Array.isArray(blocks) && blocks.length === 3) throw new Error("request timed out");
      return replay.send(body);
    },
  };
  const { output } = await runProbe(params, flaky);
  assert.equal(output.verdict, "INCOMPLETE");
  assert.equal(output.scenarios.find((scenario) => scenario.id === "sequence")!.simulated, false);
});

test("replay: Ethereum PEPE simulates on Ethereum's router with 12 s blocks", async () => {
  const { fixture, replay, params } = load("ethereum_pepe");
  const { output } = await runProbe(params, replay);
  assert.equal(output.chain, "eip155:1");
  assert.equal(output.verdict, "CONSISTENT");
  assert.equal(output.scenarios.length, 9);
  type Body = { method?: string; params?: [{ blockStateCalls: Array<{ blockOverrides: { number: string; time: string }; calls: Array<{ to: string }> }> }] };
  const sims = fixture.exchanges.map((exchange) => exchange.body as Body).filter((body) => body.method === "eth_simulateV1");
  const allowed = new Set([CHAINS.ethereum.router.toLowerCase(), params.token.toLowerCase()]);
  for (const body of sims) {
    const blocks = body.params![0].blockStateCalls;
    assert.equal(BigInt(blocks[0]!.blockOverrides.time) - BigInt(output.block.timestamp!), 12n);
    assert.ok(blocks.every((block) => block.calls.every((call) => allowed.has(call.to.toLowerCase()))));
  }
  // A 10-minute hold on 12 s blocks advances 50 blocks, so the RPC's filler blocks stay behind the sell block's time.
  const gaps = sims.map((body) => body.params![0].blockStateCalls).filter((blocks) => blocks.length === 2)
    .map((blocks) => [
      Number(BigInt(blocks[1]!.blockOverrides.number) - BigInt(blocks[0]!.blockOverrides.number)),
      Number(BigInt(blocks[1]!.blockOverrides.time) - BigInt(blocks[0]!.blockOverrides.time)),
    ] as const);
  assert.ok(gaps.some(([blocks, seconds]) => blocks === 50 && seconds === 600));
  assert.ok(gaps.every(([blocks, seconds]) => (blocks - 1) * 12 < seconds));
});
