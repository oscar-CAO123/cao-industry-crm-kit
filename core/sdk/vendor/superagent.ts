// The SDK's own isolated Superagent serializes parameters; only its terminal send is replaced.
import { createRequire } from "node:module";
import { gatedFetch } from "./gate.ts";
export function gateSuperagent(app: string, req: NodeJS.Require, pkg: string) {
  const superagent = createRequire(req.resolve(pkg))("superagent");
  const send = gatedFetch(app);
  superagent.Request.prototype.end = function(callback: (error: unknown, response?: unknown) => void) {
    const request = this;
    Promise.resolve().then(async () => {
      request._finalizeQueryString();
      if (request._formData) throw new Error(`${app}: SDK streaming uploads are unsupported; use callOperation multipart parts`);
      const headers = { ...request.header };
      if (app === "asana") for (const k of Object.keys(headers)) if (k.toLowerCase() === "x-asana-client-lib") delete headers[k];
      let body = request._data;
      if (body !== undefined && typeof body !== "string" && !(body instanceof Uint8Array)) {
        const type = request.get("Content-Type") ?? "application/json";
        const serialize = superagent.serialize[type.split(";")[0]];
        if (!serialize) throw new Error(`${app}: SDK body encoding is unsupported`);
        body = serialize(body);
      }
      const r = await send(request.url, { method: request.method, headers, body });
      const text = await r.text();
      const type = r.headers.get("content-type") ?? "";
      const response = { status: r.status, statusCode: r.status, headers: Object.fromEntries(r.headers), header: Object.fromEntries(r.headers), text, body: type.includes("json") && text ? JSON.parse(text) : text, ok: r.ok };
      if (!r.ok) throw Object.assign(new Error(`Request failed with status code ${r.status}`), { status: r.status, response });
      return response;
    }).then((r) => callback(null, r), (e) => callback(e));
    return request;
  };
}
