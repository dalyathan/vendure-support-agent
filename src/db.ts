import type { OrderStatus } from "./store.ts";

export interface Order {
  id: string;
  customerEmail: string;
  item: string;
  total: number;
  status: OrderStatus;
}

export interface Customer {
  email: string;
  name: string;
}

export interface Db {
  customers: Record<string, Customer>;
  orders: Record<string, Order>;
}

const INITIAL: Db = {
  customers: {
    "alice@example.com": { email: "alice@example.com", name: "Alice Chen" },
    "bob@example.com": { email: "bob@example.com", name: "Bob Okafor" },
    "carol@example.com": { email: "carol@example.com", name: "Carol Diaz" },
  },
  orders: {
    A1001: { id: "A1001", customerEmail: "alice@example.com", item: "Trail hiking boots", total: 84.5, status: "pending" },
    A1002: { id: "A1002", customerEmail: "alice@example.com", item: "Wool socks (3-pack)", total: 25, status: "delivered" },
    B2001: { id: "B2001", customerEmail: "bob@example.com", item: "Rain jacket", total: 120, status: "shipped" },
    B2002: { id: "B2002", customerEmail: "bob@example.com", item: "Water bottle", total: 40, status: "pending" },
    C3001: { id: "C3001", customerEmail: "carol@example.com", item: "Headlamp", total: 15, status: "pending" },
  },
};

/** A fresh copy of the store database; each conversation gets its own. */
export function createDb(): Db {
  return structuredClone(INITIAL);
}
