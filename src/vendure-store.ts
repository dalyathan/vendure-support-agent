import { ORDER_STATUSES, StoreError, type CancelResult, type CustomerView, type OrderStatus, type OrderView, type StoreBackend } from "./store.ts";

/**
 * Maps the states of Vendure's default order process onto the policy's statuses. States not listed
 * (e.g. Modifying, or a shop's custom states) become "other". Shops with a custom order process add
 * their states with `stateMap` or VENDURE_STATE_MAP; which ones count as "pending" (still cancellable)
 * is a business decision for each shop.
 */
export const DEFAULT_STATE_MAP: Record<string, OrderStatus> = {
  PaymentAuthorized: "pending",
  PaymentSettled: "pending",
  PartiallyShipped: "shipped",
  Shipped: "shipped",
  PartiallyDelivered: "delivered",
  Delivered: "delivered",
  Cancelled: "cancelled",
};

export interface VendureStoreOptions {
  /** e.g. http://localhost:3000/admin-api */
  adminApiUrl: string;
  /** A Vendure API key (v3.6+, needs 'api-key' in authOptions.tokenMethod). */
  apiKey?: string;
  /** Otherwise, an administrator's login. Use a dedicated low-privilege admin, not the superadmin. */
  username?: string;
  password?: string;
  /** Extra state mappings, merged over DEFAULT_STATE_MAP. */
  stateMap?: Record<string, OrderStatus>;
  /** Statuses the store itself will cancel. A hard guard in addition to the policy prompt. */
  cancellableStatuses?: OrderStatus[];
}

interface VendureOrder {
  id: string;
  code: string;
  state: string;
  orderPlacedAt: string | null;
  totalWithTax: number;
  currencyCode: string;
  customer: { emailAddress: string } | null;
  lines: { quantity: number; productVariant: { name: string } }[];
  payments: { id: string; state: string; amount: number; refunds: { state: string; total: number }[] }[] | null;
}

const ORDER_FIELDS = `
  id code state orderPlacedAt totalWithTax currencyCode
  customer { emailAddress }
  lines { quantity productVariant { name } }
  payments { id state amount refunds { state total } }`;

/** Store backed by a Vendure Admin API. */
export class VendureStore implements StoreBackend {
  private token: string | null = null;
  private readonly stateMap: Record<string, OrderStatus>;
  private readonly cancellable: OrderStatus[];

  constructor(private readonly options: VendureStoreOptions) {
    if (!options.apiKey && !(options.username && options.password)) {
      throw new Error("VendureStore needs an apiKey, or a username and password");
    }
    this.stateMap = { ...DEFAULT_STATE_MAP, ...options.stateMap };
    this.cancellable = options.cancellableStatuses ?? ["pending"];
  }

  async lookupCustomer(email: string): Promise<CustomerView> {
    const data = await this.query<{
      customers: { items: { firstName: string; lastName: string; emailAddress: string; orders: { items: VendureOrder[] } }[] };
    }>(
      `query ($email: String!) {
        customers(options: { filter: { emailAddress: { eq: $email } } }) {
          items {
            firstName lastName emailAddress
            orders(options: { filter: { orderPlacedAt: { isNull: false } }, sort: { orderPlacedAt: DESC }, take: 20 }) {
              items { ${ORDER_FIELDS} }
            }
          }
        }
      }`,
      { email: email.trim().toLowerCase() },
    );
    const customer = data.customers.items[0];
    if (!customer) throw new StoreError(`no customer with email ${email}`);
    return {
      email: customer.emailAddress,
      name: `${customer.firstName} ${customer.lastName}`.trim(),
      orders: customer.orders.items.map((o) => this.toView(o)),
    };
  }

  async getOrder(orderId: string): Promise<OrderView> {
    return this.toView(await this.findOrder(orderId));
  }

  async cancelOrder(orderId: string, reason: string): Promise<CancelResult> {
    const order = await this.findOrder(orderId);
    const status = this.status(order.state);
    if (!this.cancellable.includes(status)) {
      throw new StoreError(`order ${order.code} has status ${status} and cannot be cancelled`);
    }

    // Cancel first, then refund: a refund on an order that then failed to cancel would ship for free.
    // cancelShipping: otherwise the shipping charge stays on the cancelled order.
    const cancelled = await this.query<{ cancelOrder: { __typename: string; state?: string; message?: string } }>(
      `mutation ($id: ID!, $reason: String) {
        cancelOrder(input: { orderId: $id, reason: $reason, cancelShipping: true }) {
          __typename
          ... on Order { state }
          ... on ErrorResult { message }
        }
      }`,
      { id: order.id, reason },
    );
    if (cancelled.cancelOrder.__typename !== "Order") {
      throw new StoreError(`Vendure refused to cancel ${order.code}: ${cancelled.cancelOrder.message}`);
    }

    // Refund what is still unrefunded on each settled payment.
    let refunded = 0;
    let allSettled = true;
    for (const payment of order.payments ?? []) {
      if (payment.state !== "Settled") continue;
      const alreadyRefunded = payment.refunds.filter((r) => r.state !== "Failed").reduce((sum, r) => sum + r.total, 0);
      const amount = payment.amount - alreadyRefunded;
      if (amount <= 0) continue;

      // Vendure 3.7 fails with a NOT NULL error on refund.shipping unless the older fields are set too.
      const result = await this.query<{ refundOrder: { __typename: string; state?: string; total?: number; message?: string } }>(
        `mutation ($paymentId: ID!, $amount: Money!, $reason: String) {
          refundOrder(input: { paymentId: $paymentId, amount: $amount, reason: $reason, lines: [], shipping: 0, adjustment: 0 }) {
            __typename
            ... on Refund { state total }
            ... on ErrorResult { message }
          }
        }`,
        { paymentId: payment.id, amount, reason },
      );
      if (result.refundOrder.__typename !== "Refund") {
        // The order is cancelled but the money is not on its way back: a plain Error, so the agent
        // reports a system fault instead of a successful cancellation.
        throw new Error(`order ${order.code} was cancelled but the refund failed: ${result.refundOrder.message}`);
      }
      refunded += result.refundOrder.total ?? amount;
      if (result.refundOrder.state !== "Settled") allSettled = false;
    }

    return {
      orderId: order.code,
      refundAmount: refunded / 100,
      currency: order.currencyCode,
      refundStatus: refunded > 0 && allSettled ? "completed" : "initiated",
    };
  }

  private async findOrder(orderId: string): Promise<VendureOrder> {
    const data = await this.query<{ orders: { items: VendureOrder[] } }>(
      `query ($code: String!) {
        orders(options: { filter: { code: { eq: $code } } }) { items { ${ORDER_FIELDS} } }
      }`,
      { code: orderId.trim().toUpperCase() },
    );
    const order = data.orders.items[0];
    // Carts and draft orders aren't the customer's orders yet, so they don't exist as far as support goes.
    if (!order || !order.orderPlacedAt) throw new StoreError(`no order ${orderId}`);
    return order;
  }

  private status(state: string): OrderStatus {
    return this.stateMap[state] ?? "other";
  }

  private toView(order: VendureOrder): OrderView {
    return {
      id: order.code,
      customerEmail: order.customer?.emailAddress ?? "",
      item: order.lines.map((l) => `${l.quantity} x ${l.productVariant.name}`).join(", "),
      // Vendure stores money in minor units (pence, cents).
      total: order.totalWithTax / 100,
      currency: order.currencyCode,
      status: this.status(order.state),
    };
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) headers["vendure-api-key"] = this.options.apiKey;
    else headers.authorization = `Bearer ${await this.login()}`;

    const res = await fetch(this.options.adminApiUrl, { method: "POST", headers, body: JSON.stringify({ query, variables }) });
    const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };

    if (json.errors?.length) {
      // A session token can expire; log in again once.
      if (!this.options.apiKey && !retried && json.errors.some((e) => e.extensions?.code === "FORBIDDEN")) {
        this.token = null;
        return this.query(query, variables, true);
      }
      throw new Error(`Vendure: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data as T;
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const res = await fetch(this.options.adminApiUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation ($u: String!, $p: String!) {
          login(username: $u, password: $p) { __typename ... on ErrorResult { message } }
        }`,
        variables: { u: this.options.username, p: this.options.password },
      }),
    });
    const json = (await res.json()) as { data?: { login: { __typename: string; message?: string } } };
    const token = res.headers.get("vendure-auth-token");
    if (json.data?.login.__typename !== "CurrentUser" || !token) {
      throw new Error(`Vendure login failed: ${json.data?.login.message ?? "no session token returned"}`);
    }
    this.token = token;
    return token;
  }
}

/** Builds a VendureStore from VENDURE_* environment variables. */
export function vendureStoreFromEnv(): VendureStore {
  const adminApiUrl = process.env.VENDURE_ADMIN_API_URL;
  if (!adminApiUrl) throw new Error("Set VENDURE_ADMIN_API_URL, e.g. http://localhost:3000/admin-api");
  return new VendureStore({
    adminApiUrl,
    apiKey: process.env.VENDURE_API_KEY,
    username: process.env.VENDURE_USERNAME,
    password: process.env.VENDURE_PASSWORD,
    stateMap: parseStateMap(process.env.VENDURE_STATE_MAP),
  });
}

/** Parses VENDURE_STATE_MAP, a JSON object such as {"AwaitingFulfillment":"pending"}. */
export function parseStateMap(json: string | undefined): Record<string, OrderStatus> | undefined {
  if (!json) return undefined;
  const map = JSON.parse(json) as Record<string, string>;
  for (const [state, status] of Object.entries(map)) {
    if (!ORDER_STATUSES.includes(status as OrderStatus)) {
      throw new Error(`VENDURE_STATE_MAP: "${state}" maps to unknown status "${status}" (use ${ORDER_STATUSES.join(", ")})`);
    }
  }
  return map as Record<string, OrderStatus>;
}
