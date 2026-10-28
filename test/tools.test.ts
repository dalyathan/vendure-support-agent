import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { MemoryStore } from "../src/memory-store.ts";
import { StoreError, type StoreBackend } from "../src/store.ts";
import { executeTool, toolDefinitions } from "../src/tools.ts";

test("lookupCustomer returns only that customer's orders", async () => {
  const result = await new MemoryStore().lookupCustomer("Bob@Example.com ");
  assert.equal(result.name, "Bob Okafor");
  assert.deepEqual(result.orders.map((o) => o.id), ["B2001", "B2002"]);
  await assert.rejects(new MemoryStore().lookupCustomer("nobody@example.com"), StoreError);
});

test("getOrder normalizes the ID", async () => {
  assert.equal((await new MemoryStore().getOrder("a1001")).total, 84.5);
  await assert.rejects(new MemoryStore().getOrder("Z9999"), StoreError);
});

test("cancelOrder changes status once and reports the refund", async () => {
  const store = new MemoryStore();
  const result = await store.cancelOrder("A1001", "test");
  assert.deepEqual(result, { orderId: "A1001", refundAmount: 84.5, currency: "USD", refundStatus: "initiated" });
  assert.equal(store.db.orders.A1001.status, "cancelled");
  await assert.rejects(store.cancelOrder("A1001", "test"), /already cancelled/);
});

test("createDb returns independent copies", async () => {
  await new MemoryStore().cancelOrder("C3001", "test");
  assert.equal(createDb().orders.C3001.status, "pending");
});

test("executeTool validates input and flags errors", async () => {
  const store = new MemoryStore();
  assert.equal((await executeTool(store, "get_order", { order_id: "B2001" })).isError, false);
  assert.equal((await executeTool(store, "get_order", { id: "B2001" })).isError, true);
  assert.equal((await executeTool(store, "delete_everything", {})).isError, true);
});

test("executeTool reports unexpected failures as system errors", async () => {
  const broken: StoreBackend = {
    lookupCustomer: async () => {
      throw new Error("connection refused");
    },
    getOrder: async () => {
      throw new StoreError("no order X");
    },
    cancelOrder: async () => {
      throw new Error("refund failed");
    },
  };
  assert.match((await executeTool(broken, "lookup_customer", { email: "a@b.c" })).output, /^Error: system error.*connection refused/);
  assert.equal((await executeTool(broken, "get_order", { order_id: "X" })).output, "Error: no order X");
});

test("tool definitions are strict JSON Schemas", () => {
  for (const tool of toolDefinitions) {
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.type, "object");
    assert.equal((tool.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
  }
});
