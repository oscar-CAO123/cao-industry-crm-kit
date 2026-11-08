// Square's official SDK (square, pinned 46.0.0, audited 8 Nov 2026) running behind the kit's gate.
// A token is always passed, so the SDK never falls back to reading SQUARE_TOKEN from the environment.
// The bundled older SDK (square/legacy) is never imported. Retries are the gate's.

import { SquareClient, SquareEnvironment } from "square";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";

export function square(): SquareClient {
  return new SquareClient({
    token: PLACEHOLDER_KEY,
    environment: SquareEnvironment.Production,
    fetch: gatedFetch("square"),
    maxRetries: 0,
  });
}
