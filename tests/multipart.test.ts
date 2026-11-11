// Agent SDK multipart tests. Every request uses a fake transport; no real app is contacted.
import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTransport, WriteBlocked } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { plan, callOperation, type CallInput } from "../core/sdk/call.ts";
import { approve, context, type WorkflowRecord } from "../core/workflows/runtime.ts";
import { FileStore } from "../core/workflows/store.ts";
import type { UploadPart } from "../core/sdk/multipart.ts";

const PYLON_UPLOAD = "post_attachments";
const UNSUPPORTED_UPLOAD = "addon-sdk-api.deployAddonSDKAddon";
const NOW = new Date("2026-11-11T00:00:00Z");
type Hit = { url: string; method: string; headers: Record<string, string>; body?: BodyInit | null };
let hits: Hit[] = [];
const work = fs.mkdtempSync(path.join(os.tmpdir(), "kit-multipart-approval-"));

after(() => fs.rmSync(work, { recursive: true, force: true }));

beforeEach(async () => {
  hits = [];
  process.env.PYLON_API_TOKEN = "fake-pylon-token";
  delete process.env.KIT_ALLOW_WRITES;
  const tokens = new MemoryTokenStore();
  setTokenStore(tokens);
  setTransport({
    sleep: async () => {},
    log: () => {},
    fetch: (async (url: any, init: any) => {
      hits.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as any,
  });
});

function parts(bytes = Buffer.from([0, 7, 128, 255])): UploadPart[] {
  return [
    { name: "caption", value: "release notes" },
    { name: "file", file: { filename: "release.bin", contentType: "application/octet-stream", base64: bytes.toString("base64") } },
  ];
}

test("multipart plan preview has field metadata but excludes text and file bytes", async () => {
  const input: CallInput = { multipart: parts() };
  const preview = await plan("pylon", PYLON_UPLOAD, input);
  const serialized = JSON.stringify(preview);
  assert.equal(preview.body, undefined);
  assert.equal(preview.json, undefined);
  assert.deepEqual(preview.multipart, [
    { name: "caption", bytes: 13 },
    { name: "file", bytes: 4, filename: "release.bin", contentType: "application/octet-stream" },
  ]);
  assert.match(preview.headers["Content-Type"], /^multipart\/form-data; boundary=/);
  assert.ok(!serialized.includes("release notes"));
  assert.ok(!serialized.includes("AAeA/w=="));
});

test("multipart writes stay blocked before any fake network call", async () => {
  await assert.rejects(callOperation("pylon", PYLON_UPLOAD, { multipart: parts() }), WriteBlocked);
  assert.equal(hits.length, 0);
});

test("approved multipart input survives JSON store roundtrip and sends text plus exact file bytes", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  const original = Buffer.from([0, 7, 128, 255]);
  const filePart = { name: "file", file: { filename: "release.bin", contentType: "application/octet-stream", base64: original.toString("base64") } } as const;
  const input: CallInput = { multipart: [{ name: "caption", value: "release notes" }, filePart] };
  const workflow: WorkflowRecord = { id: "multipart-test", name: "Multipart test", draft_ops: {}, live_ops: { pylon: [PYLON_UPLOAD] }, crons: [] };
  const dir = path.join(work, "approvals");
  fs.mkdirSync(dir, { recursive: true });
  const store = new FileStore(dir);
  const id = await context(workflow, {}, store, NOW, () => {}).queue({
    platform: "pylon", op: PYLON_UPLOAD, input, summary: "Upload a test file", key: "immutable-upload",
  });
  const stored = JSON.parse(fs.readFileSync(path.join(dir, "approvals.json"), "utf8"))[id];
  assert.equal(stored.acts[0].input.multipart[1].file.base64, original.toString("base64"));
  // Mutating the caller's object after queueing must not change the approval's persisted payload.
  (filePart.file as any).base64 = Buffer.from("changed after queue").toString("base64");
  const result = await approve(workflow, new FileStore(dir), id, "test-approver", NOW);
  assert.equal(result.status, "done");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].method, "POST");
  const contentType = Object.entries(hits[0].headers).find(([k]) => k.toLowerCase() === "content-type")?.[1];
  assert.match(String(contentType), /^multipart\/form-data; boundary=/);
  const form = await new Response(hits[0].body, { headers: { "content-type": String(contentType) } }).formData();
  assert.equal(form.get("caption"), "release notes");
  const upload = form.get("file");
  assert.ok(upload instanceof File);
  assert.equal(upload.name, "release.bin");
  assert.equal(upload.type, "application/octet-stream");
  assert.deepEqual(Buffer.from(await upload.arrayBuffer()), original);
});

test("malformed and over-limit parts are refused while planning", async () => {
  await assert.rejects(plan("pylon", PYLON_UPLOAD, { multipart: [{ name: "file", file: { filename: "bad.bin", contentType: "application/octet-stream", base64: "not base64" } }] }), /valid bounded base64/);
  await assert.rejects(plan("pylon", PYLON_UPLOAD, { multipart: [{ name: "caption", value: "x".repeat(50 * 1024 * 1024 + 1) }] }), /exceeds 50 MiB/);
  await assert.rejects(plan("pylon", PYLON_UPLOAD, { multipart: [] }), /1 to 100 parts/);
  assert.equal(hits.length, 0);
});

test("multipart endpoints cannot fall back to JSON bodies or implicit empty bodies", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  await assert.rejects(callOperation("pylon", PYLON_UPLOAD, { body: { caption: "fallback" } }), /supply multipart parts instead of a JSON body/);
  await assert.rejects(callOperation("pylon", PYLON_UPLOAD, {}), /supply multipart parts instead of a JSON body/);
  assert.equal(hits.length, 0);
});

test("ServiceM8 multipart refuses missing add-on credentials before network even with writes allowed", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  await assert.rejects(callOperation("servicem8", UNSUPPORTED_UPLOAD, {
    params: { slug: "demo-addon" }, multipart: [{ name: "manifest", value: "{}" }],
  }), /SERVICEM8_ADDON_ACCESS_TOKEN is not set/);
  assert.equal(hits.length, 0);
});
