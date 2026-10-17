# Multiverse — test-drive any token in 10 futures before you buy

A PayBox plugin for the MoonPay Hackathon (Chapter 1). Owner: Bahram (@nabu_lines).

Honeypot checkers ask one question: can a wallet sell this token right now? A clean answer at one
moment does not prove you can exit later. Multiverse simulates the agent's exact planned trade
(buy → hold → sell) across several universes on Base, Ethereum or Arbitrum: different hold times, trade
sizes, sell order and wallets. It then compares the outcomes.

- **Consistent everywhere**: the agent may buy, and `multiverse_buy` proposes the exact simulated trade.
- **Different anywhere**: the agent refuses and explains, in one line, where behavior diverged.

Defensive and read-only: every universe is an `eth_simulateV1` call against mainnet state. Nothing
is deployed or broadcast, no private keys or secrets are needed, and the plugin returns at most one
unsigned buy that PayBox shows for approval.

## Tools

| Tool | What it does |
|---|---|
| `multiverse_probe` | Read-only. Simulates the planned buy and sell in up to 10 universes and returns a verdict. |
| `multiverse_buy` | Re-checks the `now` and `t_1h` universes for this exact size and wallet. If the verdict allows it, returns one unsigned Uniswap V2 buy (`io.paybox/transactionProposal`) on the selected chain. |
| `multiverse_about` | Static: chains, scenarios, owner rules, thresholds, verdicts and limitations. No network; used as the conformance sample. |

`multiverse_probe` input: `{ token, amount_eth, wallet, chain?, horizons?, max_tax_pct? }`. `chain` is `base`
(default), `ethereum` or `arbitrum`. `amount_eth` is a decimal string from 0.0001 to 5, in that chain's
native ETH. `horizons` is a subset of `10m`, `1h`, `6h`, `24h` (default `10m`, `1h`, `24h`). `max_tax_pct`
defaults to 15.

`multiverse_buy` input: `{ token, amount_eth, wallet, chain?, max_slippage_bps? (default 300, max 1500), accept_caution? (default false) }`.
It returns no proposal for `BLOCK`, `UNSUPPORTED_VENUE` or `INCOMPLETE`, or for `CAUTION` without
`accept_caution: true`. That is a normal result, not an error. Otherwise it proposes
`swapExactETHForTokensSupportingFeeOnTransferTokens(minOut, [WETH, token], wallet, now + 300)` on the
UniswapV2Router02, with `value` set to the ETH amount and
`minOut = floor(simulated_received × (10000 − max_slippage_bps) / 10000)`.

Output (`structuredContent`, declared in `outputSchema`): `chain` (CAIP-2 id), `token` (address, `symbol_untrusted`, decimals),
`venue` (pair and WETH reserve), `block`, `scenarios[]` (each with buy/sell ok, taxes, round-trip loss and
revert reason), `flags[]`, `verdict`, `exit_horizon`, `first_divergence`, `recommendation`, `disclaimer` and
`rules_version`. `multiverse_buy` adds `buy` (what was or wasn't proposed and why), plus the proposal
when there is one. The text content is a 5–8 line plain summary.

Token symbols and revert strings are untrusted contract data. They are stripped of control and format
characters, truncated, and never placed in instructions.

## Chains

Each router was checked on-chain: `router.factory()` and `router.WETH()` match the table.

| `chain` | CAIP-2 | Uniswap V2 factory | UniswapV2Router02 | WETH | Simulated block step | RPC hosts (primary, fallback) |
|---|---|---|---|---|---|---|
| `base` (default) | `eip155:8453` | `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | `0x4200000000000000000000000000000000000006` | 2 s | `mainnet.base.org`, `base-rpc.publicnode.com` |
| `ethereum` | `eip155:1` | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | 12 s | `ethereum-rpc.publicnode.com`, `eth.drpc.org` |
| `arbitrum` | `eip155:42161` | `0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9` | `0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | 12 s | `arbitrum-one-rpc.publicnode.com`, `arb1.arbitrum.io` |

The block step is also the divisor for hold gaps: the RPC fills skipped blocks at +2 s on Base and +12 s on
Ethereum and Arbitrum, so a hold advances `min(hold / step, 200)` blocks and the filler blocks never pass the
sell block's time. Optimism was left out: its Uniswap V2 WETH pools hold well under 0.5 WETH (OP 0.19,
DAI 0.30 on 2026-10-17), so no token there could come back CONSISTENT.

## How a probe works

1. **Pre-checks** (one JSON-RPC batch): the latest block header, `factory.getPair(token, WETH)`, `decimals()`
   and `symbol()`. A zero pair returns `UNSUPPORTED_VENUE`. `getReserves()` runs alongside phase A.
2. **Phase A** (one `eth_simulateV1` per distinct sender and size): `balanceOf`, `getAmountsOut`, the buy, and
   `balanceOf` again. This gives the quoted amount `E` and the received amount `R`, taken from Transfer logs
   with the balance difference as a fallback.
3. **Phase B** (one `eth_simulateV1` per universe): block 1 repeats the buy and runs
   `approve(router, max)`. After the hold, `getAmountsOut(R, [token, WETH])` runs, followed by
   `swapExactTokensForTokensSupportingFeeOnTransferTokens(R, 0, [token, WETH], sender, deadline)`.
   The split sell does this twice, with half of `R` each time.
4. **Rules → flags → verdict** (below). Tax is `max(0, 1 − received / quoted)`, rounded to 0.1 points.

Every simulated block reuses the real latest header (`feeRecipient` = latest `miner`, `baseFeePerGas` =
latest value). Only `number` and `time` advance, and all universes are anchored to the same base block.
Calls carry a realistic gas price (base fee plus a 0.001 gwei tip), so `tx.gasprice` is never zero. The
sender's ETH balance is set by a state override (the amount plus gas for every call at the simulated fee
cap, at least 0.05 ETH), so no real funds are needed. A hold sets the sell block's `time` to the hold length
and its `number` to `min(hold / step, 200)` blocks ahead. reth caps a call at 256 simulated blocks, filler
blocks included. If the RPC rejects the gap, Multiverse retries one block ahead with the same time jump and
reports `block.number_gap_limited: true`. Any other JSON-RPC error is retried once after 300 ms, because
load-balanced public RPCs sometimes answer from a node that has not reached the anchor block yet.

Budget: 3.5 s per RPC request and 8.5 s per tool call. The plugin returns partial results as `INCOMPLETE`
rather than run past PayBox's 10 s limit. Concurrency is capped at 6 per host: the primary RPC fills
first, overflow goes to the fallback host, and a host that fails is skipped for the rest of the call.

### Universes

| id | sender | buy size | sell | when |
|---|---|---|---|---|
| `now` | user wallet | 1× | 100% | next block |
| `t_10m` / `t_1h` / `t_6h` / `t_24h` | user wallet | 1× | 100% | after the requested hold |
| `size_quarter` | user wallet | 0.25× | 100% | next block |
| `size_4x` | user wallet | 4× | 100% | next block |
| `sequence` | user wallet | 1× | 50% then 50% | next two blocks |
| `wallet_b` | fresh address (keccak of token + index) | 1× | 100% | next block |
| `wallet_c` | second fresh address | 1× | 100% | after 1 h (next block if `1h` isn't requested) |

Fresh wallets are compared with the user wallet at the same hold.

## Owner rules v1

The thresholds live in `src/rules.ts` (`RULES`) and are mirrored by `multiverse_about`.

| Condition | Flag | Effect |
|---|---|---|
| the 1× buy from the user wallet reverts | `BUY_FAILS_NOW` | BLOCK |
| `now` sell fails | `SELL_FAILS_NOW` | BLOCK |
| `now` ok, a later hold fails or its sell tax > 50% | `SELL_BREAKS_LATER` | BLOCK |
| split sell: second half fails | `SECOND_SELL_FAILS` | BLOCK |
| split sell: first half fails while selling 100% works | `PARTIAL_SELL_FAILS` | BLOCK |
| a fresh wallet succeeds/fails differently from the user wallet, or taxes differ > 10 points | `WALLET_DEPENDENT` | BLOCK |
| 0.25× or 4× fails, or its tax > 1× tax + 20 points | `SIZE_DEPENDENT` | CAUTION (reports the largest size that passed) |
| a later hold's sell tax > now + 3 points (and ≤ 50%) | `TAX_RISES_LATER` | CAUTION |
| a later hold's sell tax < now − 3 points | `TAX_DECREASES_LATER` | CAUTION ("waiting X lowers the exit cost") |
| buy tax or immediate sell tax > `max_tax_pct` | `TAX_ABOVE_LIMIT` | CAUTION |
| WETH reserve < 0.5 ETH | `THIN_LIQUIDITY` | CAUTION |
| everything succeeds but taxes spread > 3 points, no other flag | `TAX_VARIES` | CAUTION |
| any planned universe missing (timeout or RPC error) | `INCOMPLETE` | INCOMPLETE unless a BLOCK flag fired |
| all succeed, taxes within 3 points of each other | — | CONSISTENT |

Exit horizon = the longest tested hold whose sell succeeds with sell tax ≤ `max_tax_pct`.

## Human contribution

> **Bahram: write this section yourself.** It matters for the hackathon's "meaningful human contribution"
> rule. Replace each TODO with your decision and the reason, ideally from your audit experience.

- **Scenario set and horizons** (`10m`, `1h`, `24h` by default; `6h` optional; 0.25× and 4× sizes; split sell;
  two fresh wallets). TODO: why these.
- **Thresholds**: later sell tax > 50% breaks the exit; wallet delta 10 points; size delta 20 points;
  consistency band 3 points; default `max_tax_pct` 15. TODO: why these numbers.
- **Venue scope and the THIN_LIQUIDITY bound** (Uniswap V2 WETH pairs only; 0.5 WETH). TODO.
- **Rules added during the build. Confirm, change or remove each**: `BUY_FAILS_NOW` (BLOCK), `PARTIAL_SELL_FAILS`
  (BLOCK), `TAX_RISES_LATER` (CAUTION), `TAX_ABOVE_LIMIT` (CAUTION), `TAX_VARIES` (CAUTION). Also the realistic
  gas price in simulations, and anchoring all universes to one base block. TODO.
- **Wording of verdicts and recommendations** (`recommend()` in `src/engine.ts`). TODO.
- **Demo tokens and what you observed**. TODO.

## Limitations

- Uniswap V2 WETH pairs on Base, Ethereum and Arbitrum only. Aerodrome and Uniswap V3 are stretch goals.
- On Arbitrum, `block.number` inside contracts follows L1 block numbers, so number-based token logic may not
  be reproduced. PayBox must support the chosen network for a `multiverse_buy` proposal to execute.
- Simulation cannot foresee owner actions (pausing, blacklisting, changing taxes later), so "consistent" is
  not a guarantee.
- Block-number gaps are capped at 200 simulated blocks per call, so long horizons mostly advance the clock.
- Results depend on current pool state: large trades move the price, and other traders are not simulated.
- `multiverse_buy` re-checks only `now` and `t_1h`, so run `multiverse_probe` first for the full picture.

## Build and test

Requirements: Node.js 24 (reference 24.21.0) and pnpm 11.11.0, on macOS, Linux or WSL2. Starter release
1.0.2. All tooling files come from that release.

```bash
pnpm install --frozen-lockfile
pnpm test            # typecheck, deterministic double build, conformance (multiverse_about)
pnpm unit            # unit tests: ABI encoding, fixture replay, rules table (no network)
pnpm smoke <token> [amount_eth] [wallet] [tool] [chain]   # live: runs dist/plugin.mjs against mainnet
```

To record fixtures, run `pnpm exec tsx scripts/record-fixture.ts <name> <token> [amount_eth] [full|fast] [chain]`.
It saves real `eth_simulateV1` traffic, minus empty filler blocks, to `test/fixtures/`. The replay tests
require the engine to reproduce each recorded result exactly.

Upload only `dist/plugin.mjs`.

## PayBox portal configuration

- **Test & configure → Network hosts:** for Base, `mainnet.base.org` (primary) and `base-rpc.publicnode.com`
  (fallback). For Ethereum, add `ethereum-rpc.publicnode.com` and `eth.drpc.org`. For Arbitrum, add
  `arbitrum-one-rpc.publicnode.com` and `arb1.arbitrum.io`. All support `eth_simulateV1` (verified 2026-10-17).
- Live multi-chain checks (2026-10-17): PEPE on Ethereum and ARB and LION on Arbitrum are CONSISTENT, 9/9
  universes in 0.9–1.1 s.
- **Variables & Secrets:** none.
- Conformance sample (`paybox-plugin.json`): `{"tool":"multiverse_about","arguments":{}}`.
- Portal test inputs:
  - probe: `{"token":"0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b","amount_eth":"0.002","wallet":"<your Base wallet>"}` (VIRTUAL, CONSISTENT)
  - buy: the same input on `multiverse_buy` returns a proposal. Use **Validate transaction** with the same wallet.

## Tested tokens (Base mainnet, 2026-10-17)

These are live probes of the 9-universe set at 0.002 ETH unless noted. Snapshot columns are what GoPlus
and honeypot.is reported at the same time.

| Token | Multiverse | First divergence | Single-snapshot checkers |
|---|---|---|---|
| VIRTUAL `0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b` | CONSISTENT | none (0% / 0%, round trip 0.6%) | clean |
| OPAL `0x119b63b1605be3a8ff4543c7f76f7f1f79eecd1f` | CONSISTENT | none (5% / 5% tax everywhere) | clean |
| PRXN `0xa0865cf95b23c35b980736878892848c62783214` at 0.4 ETH | CAUTION `SIZE_DEPENDENT` | a 1.6 ETH trade fails (max sell is 1% of supply) | GoPlus clean, honeypot.is low risk |
| G2G `0x578ec5f37e0e459dec94805bf7b122e931eb34e4` | BLOCK `SELL_FAILS_NOW` | selling right after buying fails, although selling after 10m works (sell cooldown) | GoPlus: cooldown |
| Joy `0x59c78b07247b621aa17997aa5b27df86bb036613` | BLOCK `SELL_FAILS_NOW` | selling right after buying fails | GoPlus: not a honeypot; honeypot.is: honeypot |
| KEKIUS `0x8c7569468d8b08d3fb6cf8f52b53af3c2b9a94b3` | CAUTION `TAX_ABOVE_LIMIT` | the sell tax (50%) is above the 15% limit | 50% sell tax |
| Temo `0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14` | BLOCK `BUY_FAILS_NOW` | the buy itself reverts (drained pool) | — |

Known blind spot: PEPETO (`0x7750c906cf0774f5a05ded0fb96ef8cd412af376`) blocks holders through an
owner-run registry. Fresh wallets are never flagged, so the default probe says CONSISTENT, while
honeypot.is reports that 348 of 349 real holders cannot sell. Probing with a flagged holder's address as
`wallet` returns BLOCK (`SELL_FAILS_NOW`, `WALLET_DEPENDENT`). A "recent real holder" universe would catch
this; it is a candidate for the next scenario set.

## Agent flow

1. User: "Buy $5 of <token> on Base."
2. Agent: `list_credentials` / `get_portfolio` → Base wallet address and ETH balance.
3. Agent: `use_plugin(multiverse, multiverse_probe, { token, amount_eth, wallet })`.
4. On CONSISTENT, the agent calls `multiverse_buy`. PayBox shows the approval (passkey or autonomous limits),
   and the agent polls `get_request` until it completes. On CAUTION, the agent explains (e.g. "sell tax falls
   after 1h") and asks the user. On BLOCK, the agent refuses and shows the first divergence in one line.

## Submission copy

- **Name:** Multiverse — test-drive any token in 10 futures before you buy
- **What it does:** Honeypot checkers test one moment. Multiverse simulates your agent's exact buy and sell on
  Base across hold times, trade sizes, sell order and wallets. Consistent everywhere: it proposes the exact
  simulated trade. Different anywhere: the agent won't buy.
