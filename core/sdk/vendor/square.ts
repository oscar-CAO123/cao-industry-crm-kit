// Square's official SDK (square, pinned 46.0.0 in vendor-sdks/square, audited 8 Nov 2026) behind the gate.
// A token is always passed, so the SDK never falls back to reading SQUARE_TOKEN from the environment.
// The bundled older SDK (square/legacy) is never imported. Retries are the gate's.

import type { SquareClient } from "square";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
import { vendorRequire } from "./load.ts";

export function square(): SquareClient {
  const { SquareClient: Client, SquareEnvironment } = vendorRequire("square")("square");
  return new Client({
    token: PLACEHOLDER_KEY,
    environment: SquareEnvironment.Production,
    fetch: gatedFetch("square"),
    maxRetries: 0,
  });
}
