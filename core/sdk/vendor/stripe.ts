// Stripe's official SDK (stripe-node, pinned 23.1.0, audited 8 Nov 2026) running behind the kit's gate.
// telemetry: false stops it writing an id file to the home folder and reporting this machine.
// Retries are the gate's, so the SDK's own are off.
//
// When it loads under Claude Code, stripe-node prints a hint on stderr that makes Claude Code offer to
// install Stripe's plugin (it did exactly that on 8 Nov 2026 during the pilot). The kit never changes the
// agent it runs in, so the two variables it looks for are hidden while the module loads, then restored.

import type StripeType from "stripe";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";

const HINT_ENV = ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION"];
const saved = HINT_ENV.map((k) => [k, process.env[k]] as const);
for (const k of HINT_ENV) delete process.env[k];
let Stripe: typeof StripeType;
try {
  Stripe = (await import("stripe")).default;
} finally {
  for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
}

export function stripe(): StripeType {
  return new Stripe(PLACEHOLDER_KEY, {
    httpClient: Stripe.createFetchHttpClient(gatedFetch("stripe")),
    telemetry: false,
    maxNetworkRetries: 0,
  });
}
