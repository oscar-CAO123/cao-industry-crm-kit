// Stripe's official SDK (stripe-node, pinned 23.1.0 in vendor-sdks/stripe, audited 8 Nov 2026) behind the gate.
// telemetry: false stops it writing an id file to the home folder and reporting this machine.
// Retries are the gate's, so the SDK's own are off.
//
// When it loads under Claude Code, stripe-node prints a hint on stderr that makes Claude Code offer to
// install Stripe's plugin (it did exactly that on 8 Nov 2026 during the pilot). The kit never changes the
// agent it runs in, so the two variables it looks for are hidden while the module loads, then restored.

import type StripeType from "stripe";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
import { vendorRequire } from "./load.ts";

const HINT_ENV = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"];
let Stripe: typeof StripeType | undefined;

function load(): typeof StripeType {
  if (Stripe) return Stripe;
  const req = vendorRequire("stripe");
  const saved = HINT_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of HINT_ENV) delete process.env[k];
  try {
    const mod = req("stripe");
    Stripe = (mod.default ?? mod) as typeof StripeType;
  } finally {
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
  return Stripe;
}

export function stripe(): StripeType {
  const S = load();
  return new S(PLACEHOLDER_KEY, {
    httpClient: S.createFetchHttpClient(gatedFetch("stripe")),
    telemetry: false,
    maxNetworkRetries: 0,
  });
}
