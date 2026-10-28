/**
 * The store the agent's tools talk to. Two implementations: an in-memory store for fast, repeatable
 * evals, and a Vendure store for a real shop. Both return the same shapes, so the policy and the
 * agent don't care which one is behind the tools.
 */

/** Order status in the policy's vocabulary. Backends map their own states onto these. */
export type OrderStatus =
  | "pending" // paid, not shipped yet
  | "shipped"
  | "delivered"
  | "cancelled"
  | "other"; // anything else, e.g. a custom state or an order a staff member needs to look at

export const ORDER_STATUSES: OrderStatus[] = ["pending", "shipped", "delivered", "cancelled", "other"];

export interface OrderView {
  id: string;
  customerEmail: string;
  item: string;
  /** In major units, e.g. 84.5 for $84.50. */
  total: number;
  currency: string;
  status: OrderStatus;
}

export interface CustomerView {
  email: string;
  name: string;
  orders: OrderView[];
}

export interface CancelResult {
  orderId: string;
  refundAmount: number;
  currency: string;
  /** "initiated": the refund has been started but the payment provider hasn't confirmed it yet. */
  refundStatus: "initiated" | "completed";
}

/** Expected failures (unknown order, not allowed) that the agent should be told about. */
export class StoreError extends Error {}

export interface StoreBackend {
  lookupCustomer(email: string): Promise<CustomerView>;
  getOrder(orderId: string): Promise<OrderView>;
  cancelOrder(orderId: string, reason: string): Promise<CancelResult>;
}
