import path from "node:path";
import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function airtable() {
  const req = vendorRequire("airtable");
  const entry = req.resolve("airtable");
  const fetchPath = path.join(path.dirname(entry), "fetch.js");
  if (Object.keys(req.cache).some((key) => key.startsWith(path.dirname(entry) + path.sep) && key !== fetchPath) && req.cache[fetchPath]?.exports !== safeFetch) throw new Error("Airtable SDK was already loaded without the kit gate");
  req(fetchPath);
  req.cache[fetchPath]!.exports = safeFetch;
  const Airtable = req("airtable");
  return new Airtable({ apiKey: PLACEHOLDER_KEY, noRetryIfRateLimited: true });
}
const send = gatedFetch("airtable");
const safeFetch: typeof globalThis.fetch = (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  const app = headers.get("x-airtable-application-id");
  const base = new URL(url).pathname.match(/^\/v0\/([^/]+)/)?.[1];
  if (app && (!base || decodeURIComponent(base) !== app)) throw new Error("Airtable base header must match the mapped path");
  headers.delete("x-airtable-application-id");
  headers.delete("x-airtable-user-agent");
  if (headers.get("x-api-version") !== "0.1.0") throw new Error("unsupported Airtable SDK version");
  headers.delete("x-api-version");
  let signal = init.signal;
  if (signal && !(signal instanceof AbortSignal)) {
    const controller = new AbortController();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
    signal = controller.signal;
  }
  return send(input, { ...init, headers, signal });
};
