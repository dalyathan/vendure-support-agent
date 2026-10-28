import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Db } from "./db.ts";

// The tools only enforce data integrity (an order must exist, a cancelled order stays cancelled).
// Business rules live in the policy prompt, so the eval measures whether the agent follows them.

const LookupCustomer = z.object({ email: z.string().describe("The customer's email address") });
const GetOrder = z.object({ order_id: z.string().describe("Order ID, e.g. A1001") });
const CancelOrder = z.object({ order_id: z.string().describe("Order ID to cancel") });

export function lookupCustomer(db: Db, { email }: z.infer<typeof LookupCustomer>): string {
  const customer = db.customers[email.trim().toLowerCase()];
  if (!customer) return `Error: no customer with email ${email}`;
  const orders = Object.values(db.orders).filter((o) => o.customerEmail === customer.email);
  return JSON.stringify({ ...customer, orders });
}

export function getOrder(db: Db, { order_id }: z.infer<typeof GetOrder>): string {
  const order = db.orders[order_id.trim().toUpperCase()];
  return order ? JSON.stringify(order) : `Error: no order ${order_id}`;
}

export function cancelOrder(db: Db, { order_id }: z.infer<typeof CancelOrder>): string {
  const order = db.orders[order_id.trim().toUpperCase()];
  if (!order) return `Error: no order ${order_id}`;
  if (order.status === "cancelled") return `Error: order ${order.id} is already cancelled`;
  order.status = "cancelled";
  return JSON.stringify({ ok: true, order_id: order.id, refund_amount: order.total });
}

const TOOLS = {
  lookup_customer: {
    description: "Look up a customer by email. Returns their name and all of their orders.",
    schema: LookupCustomer,
    run: lookupCustomer,
  },
  get_order: {
    description: "Get one order by ID: owner email, item, total, and status.",
    schema: GetOrder,
    run: getOrder,
  },
  cancel_order: {
    description: "Cancel an order and refund its total to the original payment method. This cannot be undone.",
    schema: CancelOrder,
    run: cancelOrder,
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

export function executeTool(db: Db, name: string, input: unknown): { output: string; isError: boolean } {
  const tool = TOOLS[name as ToolName];
  if (!tool) return { output: `Error: unknown tool ${name}`, isError: true };
  const parsed = tool.schema.safeParse(input);
  if (!parsed.success) return { output: `Error: invalid input: ${parsed.error.message}`, isError: true };
  // Each run() takes the input type of its own schema; the cast just joins the union.
  const output = (tool.run as (db: Db, input: unknown) => string)(db, parsed.data);
  return { output, isError: output.startsWith("Error") };
}
