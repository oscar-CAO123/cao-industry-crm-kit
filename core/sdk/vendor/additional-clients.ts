import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function pylon() {
  const { PylonClient } = vendorRequire("pylon")("@usepylon/sdk");
  return new PylonClient({ token: PLACEHOLDER_KEY, fetch: gatedFetch("pylon"), maxRetries: 0 });
}
export function microsoft365() {
  const { Client } = vendorRequire("microsoft-365")("@microsoft/microsoft-graph-client");
  const send = gatedFetch("microsoft-365");
  return Client.initWithMiddleware({ middleware: { async execute(context: any) { context.response = await send(context.request, context.options); } } });
}
