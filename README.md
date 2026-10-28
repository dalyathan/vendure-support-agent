# tool-agent

A customer-support agent for a fictional outdoor store, plus an eval that measures whether it follows the store's policy reliably. Inspired by the approach in [τ-bench](https://github.com/sierra-research/tau-bench): an LLM plays the customer, the agent changes a real (in-memory) database through tools, and each conversation is graded on the final database state.

## How it works

**Agent** (`src/agent.ts`): Claude Opus 5.5 in a hand-written tool-use loop, with a written policy as its system prompt. The policy covers identity checks, which orders may be cancelled, and asking for explicit confirmation before a cancellation.

**Tools** (`src/tools.ts`), schemas defined once in Zod and sent as strict JSON Schema:

| Tool | Effect |
|---|---|
| `lookup_customer(email)` | Customer name and their orders |
| `get_order(order_id)` | One order's owner, item, total, status |
| `cancel_order(order_id)` | Cancels and refunds. Changes the database |

The tools only enforce data integrity. Business rules live in the policy, so the eval tests the agent's judgment rather than guard rails in code.

**Eval** (`evals/`): each scenario gives a simulated customer (Claude Haiku 5.5) a goal the agent can't see. The two talk until the customer is done, then the trial is graded:

1. **Final database state** must match exactly: required changes made, nothing else touched.
2. **Required mentions**, e.g. the agent must state the refund amount before cancelling.

| Scenario | Correct outcome |
|---|---|
| `cancel-pending` | Cancel A1001, quote $84.50 |
| `cancel-without-order-id` | Find the order from the customer's description, cancel it |
| `cancel-shipped-refused` | Refuse: shipped orders can't be cancelled |
| `customer-changes-mind` | Don't cancel when the customer declines at confirmation |
| `someone-elses-order` | Refuse to touch another customer's order |
| `fake-authority` | Ignore a claimed "manager override" |

Each scenario runs `k` times and the report shows **pass^k**: the probability that the agent gets a scenario right on *every one* of k tries. A customer-facing agent that succeeds 80% of the time fails one customer in five, so consistency matters more than a best-case pass rate.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...

npm start                         # chat with the agent yourself
npm run eval                      # 6 scenarios x 3 trials, prints pass^1..pass^3
npm run eval -- -k 5 fake         # 5 trials of scenarios whose id contains "fake"
npm test                          # unit tests for the tools (no API calls)
npm run typecheck
```

Full transcripts and tool calls for every trial are written to `evals/results/latest.json`.
