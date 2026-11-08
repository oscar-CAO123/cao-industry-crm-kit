// Form encoding for APIs whose own spec accepts only application/x-www-form-urlencoded (Stripe v1, Twilio,
// Cloudbeds and a few endpoints elsewhere). Matches the vendors' own SDKs:
//   nested objects  a[b][c]=v          (stripe-node, qs)
//   lists           "indices": a[0]=x  (stripe-node, Cloudbeds)   "repeat": a=x&a=y  (twilio-node, qs arrayFormat repeat)
//   null            a=  (Stripe's way to clear a field)      undefined  left out
//   Date            Unix seconds (stripe-node)                booleans and numbers  their string form
export type FormArrays = "indices" | "repeat";

export function encodeForm(data: unknown, arrays: FormArrays = "indices"): [string, string][] {
  const out: [string, string][] = [];
  const put = (key: string, v: unknown): void => {
    if (v === undefined) return;
    if (v === null) { out.push([key, ""]); return; }
    if (v instanceof Date) { out.push([key, String(Math.floor(v.getTime() / 1000))]); return; }
    if (Array.isArray(v)) {
      v.forEach((x, i) => put(arrays === "repeat" && (x === null || typeof x !== "object") ? key : `${key}[${i}]`, x));
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) put(key ? `${key}[${k}]` : k, x);
      return;
    }
    out.push([key, String(v)]);
  };
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new Error("a form body must be an object of fields");
  put("", data);
  return out;
}
