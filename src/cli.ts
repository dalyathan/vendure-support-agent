import readline from "node:readline/promises";
import { SupportAgent } from "./agent.ts";
import { MemoryStore } from "./memory-store.ts";
import type { StoreBackend } from "./store.ts";
import { vendureStoreFromEnv } from "./vendure-store.ts";

// Chat with the agent as a customer.
// Memory store (default): try alice@example.com, bob@example.com or carol@example.com.
// Vendure: STORE_BACKEND=vendure with VENDURE_* variables set (see README).
const useVendure = process.env.STORE_BACKEND === "vendure";
const store: StoreBackend = useVendure ? vendureStoreFromEnv() : new MemoryStore();
const storeName = process.env.STORE_NAME ?? (useVendure ? "our shop" : "Trailhead Gear");
const agent = new SupportAgent(store, storeName);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log(`${storeName} support (${useVendure ? "Vendure" : "in-memory"} store). Type "exit" to quit.\n`);
let seen = 0;
while (true) {
  const line = (await rl.question("you> ")).trim();
  if (!line || line === "exit") break;
  const reply = await agent.respond(line);
  for (const call of agent.toolCalls.slice(seen)) {
    console.log(`  [tool] ${call.name}(${JSON.stringify(call.input)}) -> ${call.output}`);
  }
  seen = agent.toolCalls.length;
  console.log(`agent> ${reply}\n`);
}
rl.close();
