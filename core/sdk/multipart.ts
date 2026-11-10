// JSON-safe upload input survives the workflow approval store without reading a changing local file.
export type UploadPart = { name: string; value: string } | { name: string; file: { filename: string; contentType: string; base64: string } };
const MAX_BYTES = 50 * 1024 * 1024;
const safeName = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\r\n\0"\\]/.test(v);

export async function encodeMultipart(parts: UploadPart[]) {
  if (!Array.isArray(parts) || !parts.length || parts.length > 100) throw new Error("upload needs 1 to 100 parts");
  const form = new FormData();
  const summary: { name: string; bytes: number; filename?: string; contentType?: string }[] = [];
  let total = 0;
  for (const part of parts) {
    if (!part || !safeName(part.name)) throw new Error("upload part has an invalid name");
    if (Object.hasOwn(part, "file") === Object.hasOwn(part, "value")) throw new Error("upload part needs either a text value or a file");
    if ("value" in part) {
      if (typeof part.value !== "string") throw new Error("upload text must be a string");
      const bytes = Buffer.byteLength(part.value); total += bytes;
      if (total > MAX_BYTES) throw new Error("upload exceeds 50 MiB");
      form.append(part.name, part.value); summary.push({ name: part.name, bytes });
    } else {
      const f = part.file;
      if (!f || !safeName(f.filename) || /[\/]/.test(f.filename)) throw new Error("upload file needs a plain filename");
      if (typeof f.contentType !== "string" || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(f.contentType)) throw new Error("upload file needs a valid content type");
      if (typeof f.base64 !== "string" || f.base64.length > Math.ceil(MAX_BYTES / 3) * 4 || (f.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.base64))) throw new Error("upload file needs valid bounded base64 data");
      const bytes = Buffer.from(f.base64, "base64");
      if (bytes.toString("base64") !== f.base64) throw new Error("upload file has noncanonical base64 data");
      total += bytes.length;
      if (total > MAX_BYTES) throw new Error("upload exceeds 50 MiB");
      form.append(part.name, new Blob([bytes], { type: f.contentType }), f.filename);
      summary.push({ name: part.name, bytes: bytes.length, filename: f.filename, contentType: f.contentType });
    }
  }
  const response = new Response(form);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error("encoded upload exceeds 50 MiB");
  return { body, contentType: response.headers.get("content-type")!, summary };
}
