import readline from "node:readline/promises";
import { SupportAgent } from "./agent.ts";
import { createDb } from "./db.ts";

// Chat with the agent as a customer. Try alice@example.com, bob@example.com or carol@example.com.
const db = createDb();
const agent = new SupportAgent(db);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('Trailhead Gear support. Type "exit" to quit.\n');
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
