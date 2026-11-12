import { isDeepStrictEqual } from "node:util";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { callOperation, plan, type CallInput } from "../call.ts";
import { ApiError, WriteBlocked, writesAllowed } from "../../lib/http.ts";
// Shopify's catalogue is an operation index. Bind each SDK request to one validated mapped
// document, so a raw GraphQL mutation can never masquerade as a read.
export async function shopify(opId: string, input: CallInput) {
  const fixed: CallInput = structuredClone({ ...input, signal: undefined });
  const preview = await plan("shopify", opId, fixed);
  if (preview.kind === "write" && !writesAllowed()) throw new WriteBlocked(`shopify ${opId}`);
  const expected = preview.json as { query: string; variables: Record<string, unknown> };
  const url = new URL(preview.url);
  const version = url.pathname.split("/")[3];
  const { createAdminApiClient } = vendorRequire("shopify")("@shopify/admin-api-client");
  const customFetchApi = async (request: string, init: RequestInit = {}) => {
    if (String(request) !== preview.url || init.method?.toUpperCase() !== "POST" || typeof init.body !== "string") throw new Error("Shopify SDK request changed the mapped operation");
    const actual = JSON.parse(init.body);
    if (actual.query !== expected.query || !isDeepStrictEqual(actual.variables ?? {}, expected.variables) || Object.keys(actual).some((k) => k !== "query" && k !== "variables")) throw new Error("Shopify SDK document changed the mapped operation");
    try {
      const r = await callOperation<ArrayBuffer>("shopify", opId, { ...fixed, binary: true, signal: input.signal });
      return new Response(r.status === 204 ? null : r.data, { status: r.status, headers: r.headers });
    } catch (e) {
      if (e instanceof ApiError) return Response.json({ errors: [{ message: e.message }] }, { status: e.status });
      throw e;
    }
  };
  const client = createAdminApiClient({ storeDomain: url.origin, apiVersion: version, accessToken: PLACEHOLDER_KEY, customFetchApi, retries: 0 });
  return client.request(expected.query, { variables: expected.variables, retries: 0 });
}
