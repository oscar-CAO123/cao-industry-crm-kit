#!/usr/bin/env node
// Serves the built demo (demo/dist) and nothing else. No dependencies, no cookies, no writes: every file is read into
// memory at start and a request can only ever get one of those files back.
//   PORT                  port to listen on (default 8080)
//   DEMO_FRAME_ANCESTORS  origins (space or comma separated) allowed to show the demo in a frame, e.g. https://hub.example.com
//                         (unset: the demo cannot be framed at all)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** Keeps only well-formed https origins (or http on localhost, for a local check). Anything else is dropped. */
export function frameAncestors(value) {
  const out = [];
  for (const item of String(value ?? "").split(/[\s,]+/).filter(Boolean)) {
    let u;
    try { u = new URL(item); } catch { continue; }
    const local = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if ((u.protocol !== "https:" && !local) || u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) continue;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(u.hostname)) continue; // a plain host only: no wildcards, no directive text
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out.length ? out.join(" ") : "'none'";
}

/** Headers every response carries, files and errors alike. */
export function baseHeaders(ancestors) {
  const policy = [
    "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
    "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", `frame-ancestors ${ancestors}`,
  ].join("; ");
  return {
    "Content-Security-Policy": policy,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // The host shows the demo in a sandboxed frame, which gives the page an opaque origin; "same-origin" would then
    // block its own script and style files. They are public static files with made-up data, so any origin may load them.
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()",
    "Strict-Transport-Security": "max-age=31536000",
  };
}

export function headersFor(file, ancestors) {
  return { ...baseHeaders(ancestors), "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": file.endsWith(".html") ? "no-cache" : "public, max-age=300" };
}

/** Reads every file of the built demo into memory, keyed by its URL path. */
export function loadFiles(dist = path.join(here, "dist")) {
  const files = new Map();
  for (const name of fs.readdirSync(dist)) {
    if (!TYPES[path.extname(name)]) continue;
    files.set(`/${name}`, fs.readFileSync(path.join(dist, name)));
  }
  if (!files.has("/index.html")) throw new Error(`no index.html in ${dist}: run node demo/build.mjs first`);
  return files;
}

export function createServer({ files = loadFiles(), ancestors = frameAncestors(process.env.DEMO_FRAME_ANCESTORS) } = {}) {
  // Node only enforces the timeouts below on this check, every 30 s by default.
  const server = http.createServer({ connectionsCheckingInterval: 2_000 }, (req, res) => {
    const plain = { ...baseHeaders(ancestors), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { ...plain, Allow: "GET, HEAD" }); return res.end("Method not allowed\n"); }
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/healthz") { res.writeHead(200, plain); return res.end(req.method === "HEAD" ? undefined : "ok\n"); }
    const key = pathname === "/" ? "/index.html" : pathname;
    const body = files.get(key);
    if (!body) { res.writeHead(404, plain); return res.end("Not found\n"); }
    res.writeHead(200, { ...headersFor(key, ancestors), "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
  // A static file server needs seconds, not Node's minutes: slow or idle clients are cut off early.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 1_000;
  // Malformed requests get the same headers as everything else, then the socket is closed.
  server.on("clientError", (error, socket) => {
    if (!socket.writable || error.code === "ECONNRESET") return socket.destroy();
    const status = error.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : error.code === "ERR_HTTP_REQUEST_TIMEOUT" ? "408 Request Timeout" : "400 Bad Request";
    const headers = { ...baseHeaders(ancestors), "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", Connection: "close", "Content-Length": "0" };
    socket.end(`HTTP/1.1 ${status}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
  });
  return server;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  const port = process.env.PORT === undefined ? 8080 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error(`PORT must be a whole number from 1 to 65535, got ${JSON.stringify(process.env.PORT)}`); process.exit(1); }
  const host = process.env.HOST || "0.0.0.0";
  const ancestors = frameAncestors(process.env.DEMO_FRAME_ANCESTORS);
  createServer({ ancestors }).listen(port, host, () => console.log(`demo on http://${host}:${port} (frame-ancestors ${ancestors})`));
}
