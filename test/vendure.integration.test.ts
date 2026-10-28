/**
 * Runs the Vendure store against a real (local) Vendure server. Skipped unless VENDURE_ADMIN_API_URL is set.
 * Needs a placed, still-cancellable order for the test customer: `npm run vendure:setup-dev -- --place-order`.
 * It cancels and refunds that order.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { StoreError } from "../src/store.ts";
import { vendureStoreFromEnv } from "../src/vendure-store.ts";

const enabled = Boolean(process.env.VENDURE_ADMIN_API_URL);
const CUSTOMER = process.env.VENDURE_TEST_CUSTOMER ?? "";

test("Vendure store", { skip: !enabled && "VENDURE_ADMIN_API_URL not set" }, async (t) => {
  assert.ok(CUSTOMER, "set VENDURE_TEST_CUSTOMER to the email of a test customer with a placed order");
  const store = vendureStoreFromEnv();

  await t.test("unknown customer is a StoreError", async () => {
    await assert.rejects(store.lookupCustomer("nobody-at-all@example.com"), StoreError);
  });

  const customer = await store.lookupCustomer(CUSTOMER);
  const pending = customer.orders.find((o) => o.status === "pending");

  await t.test("lookup returns placed orders in policy statuses", () => {
    assert.ok(customer.orders.length > 0, "customer has no placed orders; run vendure:setup-dev --place-order");
    for (const order of customer.orders) {
      assert.equal(order.customerEmail, CUSTOMER);
      assert.ok(order.total >= 0 && order.currency.length === 3);
    }
    assert.ok(pending, "no pending order to cancel; run vendure:setup-dev --place-order");
  });
  if (!pending) return;

  await t.test("getOrder matches the lookup", async () => {
    assert.deepEqual(await store.getOrder(pending.id.toLowerCase()), pending);
  });

  await t.test("cancel refunds everything the customer paid", async () => {
    const result = await store.cancelOrder(pending.id, "integration test");
    assert.equal(result.orderId, pending.id);
    // The order total is what was paid, so this is a full refund. (The cancelled order's own total can
    // stay above zero: surcharges are not removed by cancelOrder.)
    assert.equal(result.refundAmount, pending.total);
    assert.equal(result.currency, pending.currency);
    assert.equal((await store.getOrder(pending.id)).status, "cancelled");
  });

  await t.test("a cancelled order cannot be cancelled again", async () => {
    await assert.rejects(store.cancelOrder(pending.id, "again"), /cannot be cancelled/);
  });

  await t.test("the agent's login cannot do admin-only things", async () => {
    // Uses the same credentials as the store, straight against the API.
    const url = process.env.VENDURE_ADMIN_API_URL!;
    const login = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `mutation ($u: String!, $p: String!) { login(username: $u, password: $p) { __typename } }`,
        variables: { u: process.env.VENDURE_USERNAME, p: process.env.VENDURE_PASSWORD },
      }),
    });
    const token = login.headers.get("vendure-auth-token");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query: `{ administrators { totalItems } }` }),
    });
    const json = (await res.json()) as { errors?: { extensions?: { code?: string } }[] };
    assert.equal(json.errors?.[0]?.extensions?.code, "FORBIDDEN");
  });
});
