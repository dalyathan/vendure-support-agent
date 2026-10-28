import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { StoreError, type StoreBackend } from "./store.ts";

const LookupCustomer = z.object({ email: z.string().describe("The customer's email address") });
const GetOrder = z.object({ order_id: z.string().describe("Order ID, e.g. A1001") });
const CancelOrder = z.object({
  order_id: z.string().describe("Order ID to cancel"),
  reason: z.string().describe("Short reason for the cancellation, in the customer's words"),
});

const TOOLS = {
  lookup_customer: {
    description: "Look up a customer by email. Returns their name and their placed orders.",
    schema: LookupCustomer,
    run: (store: StoreBackend, { email }: z.infer<typeof LookupCustomer>) => store.lookupCustomer(email),
  },
  get_order: {
    description: "Get one order by ID: owner email, items, total, currency, and status.",
    schema: GetOrder,
    run: (store: StoreBackend, { order_id }: z.infer<typeof GetOrder>) => store.getOrder(order_id),
  },
  cancel_order: {
    description:
      "Cancel an order and start a refund of its total to the original payment method. This cannot be undone.",
    schema: CancelOrder,
    run: (store: StoreBackend, { order_id, reason }: z.infer<typeof CancelOrder>) =>
      store.cancelOrder(order_id, reason),
  },
} as const;

export type ToolName = keyof typeof TOOLS;

/** Tool definitions in the API's format, with JSON Schemas generated from the Zod schemas. */
export const toolDefinitions: Anthropic.Beta.BetaTool[] = Object.entries(TOOLS).map(([name, t]) => {
  const { $schema, ...schema } = z.toJSONSchema(t.schema);
  return {
    name,
    description: t.description,
    input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
    strict: true,
  };
});

/** Runs a tool and returns its result as text for the model. Never throws. */
export async function executeTool(
  store: StoreBackend,
  name: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const tool = TOOLS[name as ToolName];
  if (!tool) return { output: `Error: unknown tool ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { output: `Error: invalid input: ${parsed.error.message}`, isError: true };

  try {
    // Each run() takes the input type of its own schema; the cast just joins the union.
    const result = await (tool.run as (store: StoreBackend, input: unknown) => Promise<unknown>)(store, parsed.data);
    return { output: JSON.stringify(result), isError: false };
  } catch (err) {
    // Expected failures are shown as-is; anything else is a system fault the agent must not paper over.
    const message =
      err instanceof StoreError
        ? err.message
        : `system error, the action may not have completed: ${err instanceof Error ? err.message : String(err)}`;
    return { output: `Error: ${message}`, isError: true };
  }
}
