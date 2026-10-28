import { mkdirSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { MODEL, SupportAgent, type ToolCall } from "../src/agent.ts";
import { createDb, type Db } from "../src/db.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { SCENARIOS, type Scenario } from "./scenarios.ts";
import { SimulatedUser, STOP, USER_MODEL } from "./user-sim.ts";

const MAX_TURNS = 10;
const CONCURRENCY = 6;

interface Trial {
  scenario: string;
  trial: number;
  passed: boolean;
  failures: string[];
  transcript: { role: "customer" | "agent"; text: string }[];
  toolCalls: ToolCall[];
}

async function runTrial(scenario: Scenario, trial: number): Promise<Trial> {
  const store = new MemoryStore();
  const db = store.db;
  const agent = new SupportAgent(store);
  const user = new SimulatedUser(scenario.instruction);
  const transcript: Trial["transcript"] = [];
  const failures: string[] = [];

  try {
    let customerText = await user.next();
    for (let turn = 0; turn < MAX_TURNS && !customerText.includes(STOP); turn++) {
      transcript.push({ role: "customer", text: customerText });
      const reply = await agent.respond(customerText);
      transcript.push({ role: "agent", text: reply });
      customerText = await user.next(reply);
    }
    if (!customerText.includes(STOP)) failures.push(`conversation did not finish within ${MAX_TURNS} turns`);
  } catch (err) {
    failures.push(`error: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Grade on outcomes: the final database must match exactly, so a wrong extra cancellation fails too.
  const expected: Db = createDb();
  for (const [id, status] of Object.entries(scenario.expectedChanges)) expected.orders[id].status = status;
  for (const id of Object.keys(expected.orders)) {
    const want = expected.orders[id].status;
    const got = db.orders[id].status;
    if (want !== got) failures.push(`order ${id}: expected ${want}, got ${got}`);
  }
  if (!isDeepStrictEqual(db, expected) && failures.length === 0) failures.push("database differs from expected");

  const agentText = transcript.filter((t) => t.role === "agent").map((t) => t.text.toLowerCase()).join("\n");
  for (const s of scenario.mustMention ?? []) {
    if (!agentText.includes(s.toLowerCase())) failures.push(`agent never mentioned "${s}"`);
  }

  return { scenario: scenario.id, trial, passed: failures.length === 0, failures, transcript, toolCalls: agent.toolCalls };
}

/** Runs async jobs with at most `limit` in flight. */
async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return results;
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
}

/**
 * pass^k: the chance that all k independent tries at a scenario succeed, averaged over scenarios.
 * With n trials and c successes per scenario, C(c, k) / C(n, k) is an unbiased estimate.
 */
function passHatK(counts: { n: number; c: number }[], k: number): number {
  return counts.reduce((sum, { n, c }) => sum + choose(c, k) / choose(n, k), 0) / counts.length;
}

const { values, positionals } = parseArgs({
  options: { trials: { type: "string", short: "k", default: "3" } },
  allowPositionals: true,
});
const trials = Number(values.trials);
const scenarios = positionals[0] ? SCENARIOS.filter((s) => s.id.includes(positionals[0])) : SCENARIOS;

console.log(`Agent: ${MODEL}   Simulated customer: ${USER_MODEL}`);
console.log(`Running ${scenarios.length} scenarios x ${trials} trials...\n`);

const jobs = scenarios.flatMap((s) => Array.from({ length: trials }, (_, t) => () => runTrial(s, t + 1)));
const results = await pool(jobs, CONCURRENCY);

const counts: { n: number; c: number }[] = [];
for (const s of scenarios) {
  const mine = results.filter((r) => r.scenario === s.id);
  const c = mine.filter((r) => r.passed).length;
  counts.push({ n: mine.length, c });
  console.log(`${c === mine.length ? "PASS" : "FAIL"}  ${s.id.padEnd(26)} ${c}/${mine.length}`);
  for (const r of mine.filter((r) => !r.passed)) {
    console.log(`      trial ${r.trial}: ${r.failures.join("; ")}`);
  }
}

console.log("");
for (let k = 1; k <= trials; k++) console.log(`pass^${k} = ${passHatK(counts, k).toFixed(3)}`);

mkdirSync("evals/results", { recursive: true });
writeFileSync("evals/results/latest.json", JSON.stringify(results, null, 2));
console.log("\nTranscripts: evals/results/latest.json");

process.exit(results.every((r) => r.passed) ? 0 : 1);
