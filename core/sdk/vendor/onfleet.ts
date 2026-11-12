import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";

// Load an isolated copy of the pinned ESM SDK. Its two direct node-fetch imports are
// replaced during loading, and its Node 20 JSON assertion is updated for Node 22.
// The returned facade exposes only endpoint functions, never the mutable SDK client.
let clientPromise: Promise<any> | undefined;
export async function onfleet() {
  const req = vendorRequire("onfleet");
  const entry = req.resolve("@onfleet/node-onfleet");
  clientPromise ??= loadClient(entry);
  const Client = await clientPromise;
  const client = new Client(PLACEHOLDER_KEY);
  const facade: Record<string, Record<string, (...args: any[]) => unknown>> = {};
  for (const name of Object.keys(client.resources)) {
    const resource = client[name.toLowerCase()];
    const methods: Record<string, (...args: any[]) => unknown> = {};
    for (const [key, value] of Object.entries(resource)) if (typeof value === "function") methods[key] = (...args) => (value as Function)(...args);
    facade[name.toLowerCase()] = Object.freeze(methods);
  }
  return Object.freeze(facade);
}

async function loadClient(entry: string) {
  const root = pathToFileURL(path.dirname(entry) + path.sep).href;
  const marker = `kit-onfleet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const shim = `data:text/javascript,${encodeURIComponent(`import { gatedFetch } from ${JSON.stringify(new URL("./gate.ts", import.meta.url).href)}; export default gatedFetch("onfleet");`)}`;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL || "";
      if (parent.startsWith(root) && parent.includes(marker) && specifier === "node-fetch") return { url: shim, shortCircuit: true };
      const result = next(specifier, context);
      if (result.url.startsWith(root) && (parent.includes(marker) || result.url === pathToFileURL(entry).href)) {
        const u = new URL(result.url); u.searchParams.set(marker, "1"); return { ...result, url: u.href };
      }
      return result;
    },
    load(url, context, next) {
      const result = next(url, context);
      if (url.startsWith(root) && url.includes(marker) && url.endsWith(`onfleet.js?${marker}=1`)) {
        const source = String(result.source).replace("assert { type: 'json' }", "with { type: 'json' }");
        return { ...result, source };
      }
      return result;
    },
  });
  try { return (await import(`${pathToFileURL(entry).href}?${marker}=1`)).default; }
  finally { hooks.deregister(); }
}
