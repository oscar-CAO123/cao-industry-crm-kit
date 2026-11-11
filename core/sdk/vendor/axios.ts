import { gatedFetch } from "./gate.ts";
export function axiosAdapter(app: string, axios: any) {
  const send = gatedFetch(app);
  return async (config: any) => {
    const raw = typeof config.headers?.toJSON === "function" ? config.headers.toJSON() : config.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null && v !== false) headers[k] = String(v);
    const res = await send(axios.getUri(config), { method: String(config.method ?? "get").toUpperCase(), headers, body: config.data ?? undefined, signal: config.signal });
    const bytes = Buffer.from(await res.arrayBuffer());
    const response = { data: config.responseType === "arraybuffer" ? bytes : bytes.toString("utf8"), status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers), config, request: {} };
    if (!config.validateStatus || config.validateStatus(res.status)) return response;
    throw new axios.AxiosError(`Request failed with status code ${res.status}`, axios.AxiosError.ERR_BAD_RESPONSE, config, {}, response);
  };
}
