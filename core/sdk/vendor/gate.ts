// Vendor SDKs run inside the kit only through this file. Each SDK is handed gatedFetch(app) as its
// network, so every request it builds goes through sendPrepared() in core/sdk/call.ts: it must be a
// mapped endpoint, writes need KIT_ALLOW_WRITES=1, the SDK's own key is dropped and ours is added
// from the client's secret store, and the gate in core/lib/http.ts sends it (https, the app's own
// hosts, no redirects). The SDK never holds a real key: each wrapper gives it a placeholder.
//
// Errors keep the gate's rule: the SDK sees the status and our one-line message, never the vendor's
// response body, because bodies can hold client data.

import { ApiError } from "../../lib/http.ts";
import { sendPrepared } from "../call.ts";

/** The key every wrapper hands its SDK. The gate drops it; a test proves it never leaves. */
export const PLACEHOLDER_KEY = "kit-placeholder-not-a-key";

export function gatedFetch(app: string): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = (init.method ?? req?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? req?.headers).forEach((v, k) => { headers[k] = v; });
    let body: string | Uint8Array | undefined;
    const raw = init.body ?? (req?.body ? await req.arrayBuffer() : undefined);
    if (typeof raw === "string") body = raw;
    else if (raw !== undefined && raw !== null) {
      // URLSearchParams, bytes, Blob, FormData or a stream: let the platform encode it once, as fetch would.
      const r = new Response(raw as BodyInit);
      body = new Uint8Array(await r.arrayBuffer());
      const type = r.headers.get("content-type");
      if (type && !headers["content-type"]) headers["content-type"] = type;
    }
    try {
      const r = await sendPrepared(app, { method, url, headers, body, signal: (init.signal ?? req?.signal) || undefined });
      const empty = r.status === 204 || r.status === 205 || r.status === 304;
      return new Response(empty ? null : (r.data as ArrayBuffer), { status: r.status, headers: r.headers });
    } catch (e) {
      if (e instanceof ApiError) {
        return new Response(JSON.stringify({ error: { message: e.message } }), { status: e.status, headers: { "content-type": "application/json" } });
      }
      throw e;
    }
  }) as typeof fetch;
}
