/**
 * Prepares a LOCAL Vendure dev server for the agent:
 *  1. a "support-agent" role with only ReadCustomer, ReadOrder and UpdateOrder,
 *  2. an administrator with just that role, for the agent to log in as,
 *  3. with --place-order, a real placed order for a test customer, from their active cart, through
 *     Vendure's default checkout (address -> shipping method -> payment). Shops whose checkout has extra
 *     required steps need to place a test order another way, e.g. through their storefront.
 *
 * Refuses to run against anything but localhost: it uses superadmin credentials and creates data.
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "place-order": { type: "boolean", default: false } } });

const ADMIN_API = process.env.VENDURE_ADMIN_API_URL ?? "http://localhost:3000/admin-api";
const SHOP_API = process.env.VENDURE_SHOP_API_URL ?? ADMIN_API.replace(/admin-api$/, "shop-api");
const env = (name: string, fallback: string) => process.env[name] ?? fallback;

for (const url of [ADMIN_API, SHOP_API]) {
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    console.error(`Refusing to run against ${url}: this script is for a local dev server only.`);
    process.exit(1);
  }
}

/** A tiny GraphQL client that keeps the session token Vendure returns. */
function client(url: string) {
  let token = "";
  return async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
      body: JSON.stringify({ query, variables }),
    });
    token = res.headers.get("vendure-auth-token") ?? token;
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data as T;
  };
}

/** Throws if a mutation returned one of Vendure's ErrorResult types. */
function check<T extends { __typename?: string; message?: string }>(step: string, result: T): T {
  if (result.__typename && result.__typename !== "Order" && "message" in result) {
    throw new Error(`${step}: ${result.message}`);
  }
  return result;
}

const admin = client(ADMIN_API);
await admin(`mutation ($u: String!, $p: String!) { login(username: $u, password: $p) { __typename } }`, {
  u: env("VENDURE_SUPERADMIN_USERNAME", "superadmin"),
  p: env("VENDURE_SUPERADMIN_PASSWORD", "superadmin"),
});

// 1. Least-privilege role
const ROLE_CODE = "support-agent";
let role = (await admin(`{ roles(options: { filter: { code: { eq: "${ROLE_CODE}" } } }) { items { id } } }`)).roles.items[0];
if (!role) {
  role = (
    await admin(`mutation {
      createRole(input: { code: "${ROLE_CODE}", description: "Support agent", permissions: [ReadCustomer, ReadOrder, UpdateOrder] }) { id }
    }`)
  ).createRole;
}
console.log(`Role "${ROLE_CODE}": ${role.id} (ReadCustomer, ReadOrder, UpdateOrder)`);

// 2. Administrator the agent logs in as
const agentEmail = env("VENDURE_USERNAME", "support-agent@example.com");
const existing = (
  await admin(`query ($e: String!) { administrators(options: { filter: { emailAddress: { eq: $e } } }) { items { id } } }`, { e: agentEmail })
).administrators.items[0];
if (!existing) {
  await admin(
    `mutation ($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`,
    {
      input: {
        firstName: "Support",
        lastName: "Agent",
        emailAddress: agentEmail,
        password: env("VENDURE_PASSWORD", "local-dev-only"),
        roleIds: [role.id],
      },
    },
  );
}
console.log(`Administrator: ${agentEmail}${existing ? " (already existed)" : " (created)"}`);

// 3. A placed order for the test customer, from their active cart
if (values["place-order"]) {
  const shop = client(SHOP_API);
  const customer = process.env.VENDURE_TEST_CUSTOMER;
  const password = process.env.VENDURE_TEST_CUSTOMER_PASSWORD;
  const paymentMethod = process.env.VENDURE_TEST_PAYMENT_METHOD;
  if (!customer || !password || !paymentMethod) {
    throw new Error(
      "--place-order needs VENDURE_TEST_CUSTOMER, VENDURE_TEST_CUSTOMER_PASSWORD and VENDURE_TEST_PAYMENT_METHOD",
    );
  }
  await shop(`mutation ($u: String!, $p: String!) { login(username: $u, password: $p) { __typename } }`, {
    u: customer,
    p: password,
  });

  const ORDER = `__typename ... on Order { code state totalWithTax } ... on ErrorResult { message }`;
  const cart = (await shop(`{ activeOrder { code totalQuantity } }`)).activeOrder;
  if (!cart?.totalQuantity) {
    throw new Error(`${customer} has no items in their cart. Add one (e.g. through the storefront), then retry.`);
  }

  check("address", (await shop(`mutation ($i: CreateAddressInput!) { setOrderShippingAddress(input: $i) { ${ORDER} } }`, {
    i: {
      fullName: "Test Customer",
      streetLine1: "1 Test Street",
      city: "Testville",
      postalCode: "12345",
      countryCode: env("VENDURE_TEST_COUNTRY_CODE", "US"),
    },
  })).setOrderShippingAddress);

  const [shipping] = (await shop(`{ eligibleShippingMethods { id } }`)).eligibleShippingMethods;
  check("shipping", (await shop(`mutation ($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ${ORDER} } }`, { id: [shipping.id] })).setOrderShippingMethod);

  check("arranging payment", (await shop(`mutation { transitionOrderToState(state: "ArrangingPayment") { ${ORDER} } }`)).transitionOrderToState);
  const order = check("payment", (await shop(
    `mutation ($m: String!) { addPaymentToOrder(input: { method: $m, metadata: {} }) { ${ORDER} } }`,
    { m: paymentMethod },
  )).addPaymentToOrder);
  console.log(`Placed order ${order.code} for ${customer}: state ${order.state}, total ${order.totalWithTax / 100}`);
}
