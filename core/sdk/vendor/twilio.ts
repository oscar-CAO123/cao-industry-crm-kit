import { createRequire } from "node:module";
import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";
export function twilio() {
  const sid = process.env.TWILIO_ACCOUNT_SID ?? "";
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) throw new Error("TWILIO_ACCOUNT_SID must be the client's account SID");
  const req = vendorRequire("twilio"), mod = req("twilio");
  const qs = createRequire(req.resolve("twilio"))("qs");
  const send = gatedFetch("twilio");
  return mod(sid, PLACEHOLDER_KEY, { autoRetry: false, httpClient: { async request(options: any) {
    const url = new URL(options.uri);
    const account = url.pathname.match(/^\/2010-04-01\/Accounts\/([^/]+)(?:\/|\.json$)/)?.[1];
    if (url.hostname !== "api.twilio.com" || account !== sid) throw new Error("Twilio SDK requests must use the configured account");
    const query = qs.stringify(options.params, { arrayFormat: "repeat" });
    if (query) url.search = url.search ? `${url.search}&${query}` : query;
    const headers = options.headers ?? {};
    const type = headers["Content-Type"];
    const body = options.data === undefined ? undefined : type === "application/x-www-form-urlencoded" ? qs.stringify(options.data, { arrayFormat: "repeat" }) : JSON.stringify(options.data);
    const r = await send(url, { method: options.method.toUpperCase(), headers, body });
    return { statusCode: r.status, body: await r.text(), headers: Object.fromEntries(r.headers) };
  } } });
}
