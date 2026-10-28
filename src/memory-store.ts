import { createDb, type Db, type Order } from "./db.ts";
import { StoreError, type CancelResult, type CustomerView, type OrderView, type StoreBackend } from "./store.ts";

/**
 * In-memory store used by the evals. It only enforces data integrity; the business rules live in
 * the policy prompt, so the evals measure whether the agent itself follows them.
 */
export class MemoryStore implements StoreBackend {
  constructor(readonly db: Db = createDb()) {}

  async lookupCustomer(email: string): Promise<CustomerView> {
    const customer = this.db.customers[email.trim().toLowerCase()];
    if (!customer) throw new StoreError(`no customer with email ${email}`);
    const orders = Object.values(this.db.orders)
      .filter((o) => o.customerEmail === customer.email)
      .map(toView);
    return { email: customer.email, name: customer.name, orders };
  }

  async getOrder(orderId: string): Promise<OrderView> {
    return toView(this.find(orderId));
  }

  async cancelOrder(orderId: string, _reason: string): Promise<CancelResult> {
    const order = this.find(orderId);
    if (order.status === "cancelled") throw new StoreError(`order ${order.id} is already cancelled`);
    order.status = "cancelled";
    return { orderId: order.id, refundAmount: order.total, currency: "USD", refundStatus: "initiated" };
  }

  private find(orderId: string): Order {
    const order = this.db.orders[orderId.trim().toUpperCase()];
    if (!order) throw new StoreError(`no order ${orderId}`);
    return order;
  }
}

function toView(order: Order): OrderView {
  return { ...order, currency: "USD" };
}
