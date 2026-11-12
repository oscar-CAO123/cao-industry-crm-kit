import { vendorRequire } from "./load.ts";
import { gatedFetch } from "./gate.ts";
export function bigquery() {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? "";
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error("GOOGLE_CLOUD_PROJECT must be the configured project ID");
  const { BigQuery } = vendorRequire("bigquery")("@google-cloud/bigquery");
  const authClient = { getProjectId: async () => projectId, getRequestHeaders: async () => ({}) };
  const client = new BigQuery({ projectId, authClient, autoRetry: false, maxRetries: 0 });
  const send = gatedFetch("bigquery");
  // The SDK normalizes resource paths before this terminal callback. Streaming upload helpers
  // also reach it, and fail closed instead of opening their own authenticated connection.
  client.makeAuthenticatedRequest = (options: any, callback: any) => {
    if (typeof callback !== "function" || options.shouldReturnStream) throw new Error("BigQuery SDK streams are unsupported; use mapped calls");
    const run = async () => {
      const url = new URL(options.uri);
      for (const [key, value] of Object.entries(options.qs ?? {})) {
        if (value !== undefined && value !== null) for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
      }
      const headers = { ...(options.headers ?? {}) };
      const body = options.json !== undefined && options.json !== true ? JSON.stringify(options.json) : options.body;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const response = await send(url, { method: options.method ?? "GET", headers, body });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw Object.assign(new Error(`Request failed with status code ${response.status}`), { code: response.status });
      callback(null, data, { statusCode: response.status, headers: Object.fromEntries(response.headers) });
    };
    void run().catch((error) => callback(error));
  };
  // Return plain data only. SDK dataset objects expose streaming/storage methods which
  // do not use the REST request seam, so never return those objects or the client.
  return Object.freeze({ async listDatasets() {
    const [datasets] = await client.getDatasets({autoPaginate:false});
    return datasets.map((d: any) => ({ id: String(d.id) }));
  } });
}
