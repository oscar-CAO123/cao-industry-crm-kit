import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function plaid() {
  const { PlaidClient } = vendorRequire("plaid")("plaid");
  return new PlaidClient({ clientId: PLACEHOLDER_KEY, secret: PLACEHOLDER_KEY, environment: "https://production.plaid.com", fetch: gatedFetch("plaid"), maxRetries: 0 });
}
