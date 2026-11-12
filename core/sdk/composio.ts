// Composio's account-specific proxy API, also exposed as tools.proxyExecute() in its SDK.
// Local URL/account/write checks still run before the managed request is sent.
import { call, checkUrl, ApiError, WriteBlocked, writesAllowed, type AppSpec, type Reply, type CallOptions } from "../lib/http.ts";
import { secret } from "../lib/secrets.ts";
import { scanData } from "../lib/sanitise.mjs";
import { composioEnabled } from "../lib/connection-provider.ts";
import type { Planned } from "./call.ts";
import { checkManagedJson, checkManagedBytes } from "./composio-payload.ts";
export { composioEnabled };
const HOST = "backend.composio.dev";
const PATH = "/api/v3.1/tools/execute/proxy";
const SAFE_HEADER = /^(accept|content-type|idempotency-key|stripe-version|square-version|consistencylevel|xero-tenant-id|range|if-none-match|if-modified-since|revision|api-version|version|notion-version|x-myobapi-version|procore-company-id|x-organization-id|account_id|x-tenant|dropbox-api-arg|customerid|customeraccountid)$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_DOWNLOAD = 50 * 1024 * 1024;

export async function composioHttpCall<T>(vendorSpec: AppSpec, request: CallOptions, read: boolean): Promise<Reply<T>> {
  const id = vendorSpec.app;
  const prefix = `KIT_${id.toUpperCase().replace(/-/g, "_")}_COMPOSIO`;
  if (!read && !writesAllowed()) throw new WriteBlocked(`${id} ${request.method ?? "GET"}`);
  const account = secret(`${prefix}_ACCOUNT_ID`), user = secret(`${prefix}_USER_ID`);
  if (!SAFE_ID.test(account) || !SAFE_ID.test(user)) throw new Error(`${id}: invalid Composio account or user configuration`);
  const endpoint = new URL(request.url);
  for (const [k,v] of Object.entries(request.query ?? {})) if (v !== undefined && v !== null) endpoint.searchParams.set(k,String(v));
  checkUrl(vendorSpec, endpoint);
  if (endpoint.hash) throw new Error(`${id}: URL fragments are refused`);
  const method = request.method ?? "GET";
  const headers = { ...(request.headers ?? {}) };
  const contentType = () => Object.entries(headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  let payload: Record<string, unknown> = {};
  if ([request.json, request.form, request.body].filter(v => v !== undefined).length > 1) throw new Error(`${id}: multiple request bodies refused`);
  if (method === "GET" && [request.json,request.form,request.body].some(v => v !== undefined)) throw new Error(`${id}: GET cannot carry a body`);
  if (request.json !== undefined) {
    if (request.json === null || typeof request.json !== "object" || Array.isArray(request.json)) throw new Error(`${id}: Composio JSON body must be an object`);
    const encoded = JSON.stringify(request.json);
    checkManagedJson(JSON.parse(encoded));
    if (Buffer.byteLength(encoded) > MAX_UPLOAD) throw new Error(`${id}: Composio request exceeds 10 MiB`);
    payload = { body: JSON.parse(encoded) };
  } else if (request.form !== undefined || request.body !== undefined) {
    const bytes = request.form !== undefined ? Buffer.from(new URLSearchParams(request.form).toString()) : Buffer.from(request.body!);
    if (bytes.byteLength > MAX_UPLOAD) throw new Error(`${id}: Composio request exceeds 10 MiB`);
    const type = request.form !== undefined ? "application/x-www-form-urlencoded" : contentType() ?? "application/octet-stream";
    if (/[\r\n\0]/.test(type)) throw new Error(`${id}: invalid content type`);
    checkManagedBytes(bytes,type);
    payload = { binary_body: { base64: bytes.toString("base64"), content_type: type } };
  }
  const parameters = Object.entries(headers).map(([name,value]) => {
    if (!SAFE_HEADER.test(name) || /[\r\n\0]/.test(value)) throw new Error(`${id}: header ${name} is not supported by Composio transport`);
    return { in: "header", name, value };
  });
  const spec: AppSpec = { app: "composio", hosts: [HOST], readPosts: read ? [`${HOST}${PATH}`] : [] };
  const response = await call<{status?: unknown; data?: unknown; headers?: unknown; binary_data?: unknown}>(spec, {
    method: "POST", url: `https://${HOST}${PATH}`, headers: { "x-api-key": secret("COMPOSIO_API_KEY") },
    json: { connected_account_id: account, user_id: user, endpoint: endpoint.toString(), method, ...payload, parameters },
    signal: request.signal, retries: 0,
  });
  const result = response.data;
  if (!result || typeof result !== "object" || !Number.isInteger(result.status) || (result.status as number) < 100 || (result.status as number) > 599) throw new Error("composio: invalid proxy response");
  const status = result.status as number;
  if (status < 200 || status >= 300) throw new ApiError(id, status, `${method} upstream`);
  const returnedHeaders = new Headers();
  if (result.headers && typeof result.headers === "object" && !Array.isArray(result.headers)) {
    for (const [k,v] of Object.entries(result.headers)) if (typeof v === "string" && !/[\r\n\0]/.test(v)) { try { returnedHeaders.set(k,v); } catch {} }
  }
  let data: unknown = result.data;
  if (result.binary_data != null) {
    if (!request.binary) throw new Error(`${id}: binary response requires binary mode`);
    const binary = result.binary_data as {url?:unknown;size?:unknown;content_type?:unknown};
    if (!binary || typeof binary !== "object" || typeof binary.url !== "string" || (binary.size !== undefined && (typeof binary.size !== "number" || !Number.isFinite(binary.size) || binary.size < 0 || binary.size > MAX_DOWNLOAD))) throw new Error(`${id}: invalid binary response metadata`);
    const hosts = (process.env.COMPOSIO_DOWNLOAD_HOSTS ?? "").split(",").map(h=>h.trim()).filter(Boolean);
    if (!hosts.length || hosts.some(h=> !/^[a-z0-9.-]+$/.test(h) || !h.includes(".") || /^\d+(\.\d+){3}$/.test(h) || /\.(local|localhost|internal|lan|home|corp)$/.test(h))) throw new Error(`${id}: configure explicit public COMPOSIO_DOWNLOAD_HOSTS`);
    const download = await call<ArrayBuffer>({app:"composio",hosts}, {url:binary.url,binary:true,retries:0,signal:request.signal});
    data = download.data;
    if (typeof binary.content_type === "string" && !/[\r\n\0]/.test(binary.content_type)) returnedHeaders.set("content-type",binary.content_type);
  } else if (request.binary) {
    const text = data === undefined || data === null ? "" : typeof data === "string" ? data : JSON.stringify(data);
    data = new TextEncoder().encode(text).buffer;
  }
  const untrusted = request.binary ? [] : scanData(data);
  return { status, headers: returnedHeaders, data: data as T, ...(untrusted.length ? { untrusted } : {}) };
}

export async function composioCall<T>(id: string, request: Planned, vendorSpec: AppSpec, read: boolean, signal?: AbortSignal): Promise<Reply<T>> {
  if (request.multipart !== undefined) throw new Error(`${id}: multipart must be encoded by the mapped operation before proxying`);
  return composioHttpCall<T>({...vendorSpec, app:id}, {method:request.method,url:request.url,headers:request.headers,json:request.json,form:request.form,body:request.body,signal},read);
}
