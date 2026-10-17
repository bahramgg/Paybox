// Live smoke test (not bundled): runs dist/plugin.mjs over stdio and calls one tool against mainnet.
// Usage: node scripts/smoke.mjs <token> [amount_eth] [wallet] [tool] [chain]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const [token = "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", amount = "0.002", wallet = "0x8ba1f109551bD432803012645Ac136ddd64DBA72", tool = "multiverse_probe", chain] = process.argv.slice(2);
const args = tool === "multiverse_about" ? {} : { token, amount_eth: amount, wallet, ...(chain ? { chain } : {}) };

const child = spawn(process.execPath, [resolve("dist/plugin.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const started = Date.now();
child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: tool, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "multiverse-smoke", version: "0.1.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  } },
})}\n`);

for await (const line of createInterface({ input: child.stdout })) {
  const message = JSON.parse(line);
  if (message.id !== 2) continue;
  const elapsed = Date.now() - started;
  child.kill();
  if (message.error) { console.error(JSON.stringify(message.error, null, 2)); process.exit(1); }
  const { content, structuredContent: out, isError } = message.result;
  console.log(content.map((block) => block.text).join("\n"));
  if (isError) process.exit(1);
  if (out?.scenarios?.length) {
    console.log("\nscenario      hold  size_eth   buy  buy_tax  sell  sell_tax  round_trip  error");
    for (const s of out.scenarios) {
      console.log([s.id.padEnd(13), s.hold.padEnd(5), s.size_eth.padEnd(10), String(s.simulated ? s.buy_ok : "-").padEnd(5), String(s.buy_tax_pct).padEnd(8),
        String(s.simulated ? s.sell_ok : "-").padEnd(5), String(s.sell_tax_pct).padEnd(9), String(s.round_trip_loss_pct).padEnd(11), s.error ?? ""].join(" "));
    }
  }
  if (out?.buy) console.log("\nbuy:", JSON.stringify(out.buy));
  if (out?.["io.paybox/transactionProposal"]) console.log("proposal:", JSON.stringify(out["io.paybox/transactionProposal"]));
  console.log(`\n(${elapsed} ms)`);
  process.exit(0);
}
