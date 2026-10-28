import { test } from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.ts";
import { cancelOrder, executeTool, getOrder, lookupCustomer, toolDefinitions } from "../src/tools.ts";

test("lookupCustomer returns only that customer's orders", () => {
  const result = JSON.parse(lookupCustomer(createDb(), { email: "Bob@Example.com " }));
  assert.equal(result.name, "Bob Okafor");
  assert.deepEqual(result.orders.map((o: { id: string }) => o.id), ["B2001", "B2002"]);
  assert.match(lookupCustomer(createDb(), { email: "nobody@example.com" }), /^Error/);
});

test("getOrder normalizes the ID", () => {
  assert.equal(JSON.parse(getOrder(createDb(), { order_id: "a1001" })).total, 84.5);
  assert.match(getOrder(createDb(), { order_id: "Z9999" }), /^Error/);
});

test("cancelOrder changes status once and reports the refund", () => {
  const db = createDb();
  assert.equal(JSON.parse(cancelOrder(db, { order_id: "A1001" })).refund_amount, 84.5);
  assert.equal(db.orders.A1001.status, "cancelled");
  assert.match(cancelOrder(db, { order_id: "A1001" }), /already cancelled/);
});

test("createDb returns independent copies", () => {
  const a = createDb();
  cancelOrder(a, { order_id: "C3001" });
  assert.equal(createDb().orders.C3001.status, "pending");
});

test("executeTool validates input and flags errors", () => {
  const db = createDb();
  assert.equal(executeTool(db, "get_order", { order_id: "B2001" }).isError, false);
  assert.equal(executeTool(db, "get_order", { id: "B2001" }).isError, true);
  assert.equal(executeTool(db, "delete_everything", {}).isError, true);
});

test("tool definitions are strict JSON Schemas", () => {
  for (const tool of toolDefinitions) {
    assert.equal(tool.strict, true);
    assert.equal(tool.input_schema.type, "object");
    assert.equal((tool.input_schema as { additionalProperties?: boolean }).additionalProperties, false);
  }
});
