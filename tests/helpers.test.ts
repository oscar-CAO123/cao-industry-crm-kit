// Helper layer tests. Every call goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { call, setTransport, WriteBlocked, ApiError, type AppSpec } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import * as xero from "../core/connectors/xero/client.ts";
import * as gmail from "../core/connectors/google-workspace/gmail.ts";
import * as gauth from "../core/connectors/google-workspace/auth.ts";
import * as aircall from "../core/connectors/aircall/client.ts";
import * as zoom from "../core/connectors/zoom/client.ts";
import * as fireflies from "../core/connectors/fireflies/client.ts";
import * as meta from "../core/connectors/meta-ads/client.ts";
import * as calendly from "../core/connectors/calendly/client.ts";
import * as telegram from "../core/connectors/telegram/client.ts";
import * as docusign from "../core/connectors/docusign/client.ts";

type Hit = { url: string; method: string; headers: Record<string, string>; body?: string };
let hits: Hit[] = [];
let logs: string[] = [];

function fake(route: (h: Hit) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }) {
  hits = []; logs = [];
  setTransport({
    fetch: (async (url: any, init: any) => {
      const h: Hit = { url: String(url), method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body };
      hits.push(h);
      const r = route(h);
      const body = r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json));
      const st = r.status ?? 200;
      return new Response(st === 204 || st === 304 ? null : body, { status: st, headers: { "content-type": r.text !== undefined ? "text/plain" : "application/json", ...(r.headers ?? {}) } });
    }) as typeof fetch,
    sleep: async () => {},
    log: (l) => logs.push(l),
  });
}

beforeEach(() => {
  delete process.env.KIT_ALLOW_WRITES;
  setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, {
    XERO_CLIENT_ID: "id", XERO_CLIENT_SECRET: "sec", XERO_TENANT_ID: "tenant", XERO_REFRESH_TOKEN: "r0",
    AIRCALL_API_ID: "a", AIRCALL_API_TOKEN: "b", FIREFLIES_API_KEY: "ff", META_ADS_TOKEN: "ADS_SECRET", META_PAGE_TOKEN: "PAGE_SECRET",
    META_PIXEL_ID: "999", CALENDLY_API_TOKEN: "cal", TELEGRAM_BOT_TOKEN: "123:SECRETBOT", ZOOM_ACCOUNT_ID: "acc", ZOOM_CLIENT_ID: "zc", ZOOM_CLIENT_SECRET: "zs",
  });
  xero.clearTokenCache(); zoom.clearTokenCache(); gauth.clearTokenCache(); docusign.clearTokenCache();
});

const spec: AppSpec = { app: "demo", hosts: ["api.example.com"], readPosts: ["api.example.com/graphql"] };

test("gate: reads pass, writes are blocked until KIT_ALLOW_WRITES=1", async () => {
  fake(() => ({ json: { ok: true } }));
  assert.equal((await call<any>(spec, { url: "https://api.example.com/x" })).data.ok, true);
  await assert.rejects(call(spec, { method: "POST", url: "https://api.example.com/x", json: {} }), WriteBlocked);
  assert.equal(hits.length, 1, "the blocked write never reached the network");
  await call(spec, { method: "POST", url: "https://api.example.com/graphql", json: {} });
  process.env.KIT_ALLOW_WRITES = "1";
  await call(spec, { method: "DELETE", url: "https://api.example.com/x" });
  assert.equal(hits.length, 3);
});

test("gate: unknown host, http, and a key in the query are refused before a socket opens", async () => {
  fake(() => ({ json: {} }));
  await assert.rejects(call(spec, { url: "https://evil.example.org/x" }), /not one of this app's hosts/);
  await assert.rejects(call(spec, { url: "http://api.example.com/x" }), /https only/);
  await assert.rejects(call(spec, { url: "https://api.example.com/x?access_token=abc" }), /query string/);
  await assert.rejects(call(spec, { url: "https://api.example.com/x", query: { api_key: "abc" } }), /query string/);
  assert.equal(hits.length, 0);
});

test("gate: redirects are refused, errors carry the status but never the body", async () => {
  fake(() => ({ status: 302, headers: { location: "https://evil.example.org/" } }));
  await assert.rejects(call(spec, { url: "https://api.example.com/x" }), (e: any) => e instanceof ApiError && e.status === 302);
  fake(() => ({ status: 400, json: { secret_client_name: "Acme Pty Ltd" } }));
  await assert.rejects(call(spec, { url: "https://api.example.com/x" }), (e: any) => !String(e.message).includes("Acme"));
});

test("gate: a read retries on 429 and 503; a write retries only on 429", async () => {
  let n = 0;
  fake(() => (++n < 3 ? { status: n === 1 ? 429 : 503, headers: { "retry-after": "1" } } : { json: { ok: 1 } }));
  assert.equal((await call<any>(spec, { url: "https://api.example.com/x" })).data.ok, 1);
  process.env.KIT_ALLOW_WRITES = "1";
  n = 1;
  fake(() => ({ status: 503 }));
  await assert.rejects(call(spec, { method: "POST", url: "https://api.example.com/x", json: {} }), ApiError);
  assert.equal(hits.length, 1, "a 503 write is not repeated");
});

test("download redirects keep the key on the app's hosts and drop it elsewhere", async () => {
  const z: AppSpec = { app: "zoom", hosts: ["api.zoom.us"], hostPattern: /^[a-z0-9-]+\.zoom\.us$/ };
  fake((h) => h.url.includes("api.zoom.us") ? { status: 302, headers: { location: "https://us02web.zoom.us/f" } }
    : h.url.includes("us02web") ? { status: 302, headers: { location: "https://storage.example.net/f?sig=1" } } : { text: "FILE" });
  const r = await call<ArrayBuffer>(z, { url: "https://api.zoom.us/d", headers: { Authorization: "Bearer K" }, binary: true, followDownloadRedirects: true });
  assert.equal(Buffer.from(r.data).toString(), "FILE");
  assert.equal(hits[1].headers.Authorization, "Bearer K");
  assert.equal(hits[2].headers.Authorization, undefined);
});

test("xero: refresh token rotates into the store; invalid_grant re-reads the store once", async () => {
  const store = new MemoryTokenStore(); setTokenStore(store);
  await store.set("xero.refresh_token", "stale");
  let tokenCalls = 0;
  fake((h) => {
    if (h.url.includes("identity.xero.com")) {
      tokenCalls++;
      if (String(h.body).includes("refresh_token=stale")) { store.values.set("xero.refresh_token", "fresh"); return { status: 400, json: { error: "invalid_grant" } }; }
      return { json: { access_token: "AT", refresh_token: "next", expires_in: 1800 } };
    }
    return { json: { Invoices: [] } };
  });
  assert.equal(await xero.accessToken(), "AT");
  assert.equal(tokenCalls, 2);
  assert.equal(await store.get("xero.refresh_token"), "next");
});

test("xero: invoices page until a short page, Type goes in where, bills are dropped", async () => {
  const page = (n: number, type = "ACCREC") => Array.from({ length: n }, (_, i) => ({ InvoiceID: `${type}${i}`, Type: type, Status: "PAID", Contact: { ContactID: "c", Name: "n" }, LineItems: [], SubTotal: 100, TotalTax: 10, Total: 110 }));
  fake((h) => h.url.includes("identity") ? { json: { access_token: "AT", refresh_token: "r1" } }
    : h.url.includes("page=1&") || h.url.endsWith("page=1") ? { json: { Invoices: page(100) } } : { json: { Invoices: [...page(3), ...page(1, "ACCPAY")] } });
  const list = await xero.listInvoices({ type: "ACCREC" });
  assert.equal(list.length, 103);
  assert.ok(decodeURIComponent(hits[1].url).includes('where=Type=="ACCREC"'));
  assert.equal(hits[1].headers["Xero-Tenant-Id"], "tenant");
});

test("xero: a new invoice is a GST-exclusive DRAFT with Australian defaults, and needs writes on", async () => {
  fake((h) => h.url.includes("identity") ? { json: { access_token: "AT", refresh_token: "r1" } } : { json: { Invoices: [{ InvoiceID: "i1" }] } });
  const o = { contactId: "c1", dueDate: "2026-12-01", lines: [{ Description: "Work", Quantity: 1, UnitAmount: 100 }] };
  await assert.rejects(xero.createInvoice(o), WriteBlocked);
  process.env.KIT_ALLOW_WRITES = "1";
  await xero.createInvoice(o);
  const body = JSON.parse(hits.at(-1)!.body!);
  assert.equal(body.Invoices[0].Status, "DRAFT");
  assert.equal(body.Invoices[0].LineAmountTypes, "Exclusive");
  assert.equal(body.Invoices[0].LineItems[0].TaxType, "OUTPUT");
});

test("gmail: body text prefers plain and strips html; drafts refuse header injection", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  assert.equal(gmail.bodyText({ parts: [{ mimeType: "text/html", body: { data: b64("<p>Hi &amp; bye</p>") } }] }).trim(), "Hi & bye");
  assert.equal(gmail.bodyText({ parts: [{ mimeType: "text/plain", body: { data: b64("plain") } }, { mimeType: "text/html", body: { data: b64("<b>x</b>") } }] }), "plain");
  assert.throws(() => gmail.rawMessage({ from: "a@b.com", to: "x@y.com\nBcc: z@z.com", subject: "s", text: "t" }), /plain email address/);
  const raw = Buffer.from(gmail.rawMessage({ from: "a@b.com", to: "x@y.com", subject: "Hi\r\nBcc: z@z.com", text: "t" }), "base64url").toString();
  assert.ok(!/\r\nBcc:/.test(raw));
});

test("gmail: there is no send function", () => {
  assert.equal((gmail as any).send, undefined);
  assert.equal((gmail as any).sendMessage, undefined);
});

test("aircall: calls follow next_page_link; a 404 transcript is null", async () => {
  fake((h) => h.url.includes("page=2") ? { json: { calls: [{ id: 2 }], meta: { next_page_link: null } } }
    : h.url.includes("/calls?") ? { json: { calls: [{ id: 1 }], meta: { next_page_link: "https://api.aircall.io/v1/calls?page=2" } } }
    : { status: 404 });
  assert.deepEqual((await aircall.listCalls(1, 2)).map((c) => c.id), [1, 2]);
  assert.equal(await aircall.getTranscript(5), null);
  assert.equal(aircall.transcriptText([{ speaker: "internal", text: "Hello there" }, { speaker: "internal", text: "" }, { speaker: "external", text: "Hi" }]), "Rep: Hello there\nCaller: Hi");
});

test("aircall: a next_page_link to another host is refused", async () => {
  fake(() => ({ json: { calls: [], meta: { next_page_link: "https://evil.example.org/next" } } }));
  await assert.rejects(aircall.listCalls(1, 2), /not one of this app's hosts/);
});

test("zoom: attendance skips staff, the host's devices and notetakers, and times the guest", () => {
  const tl = { timeline: [
    { ts: "00:00:05.000", users: [{ username: "Sam Lee", email_address: "sam@biz.com.au" }, { username: "Fireflies.ai Notetaker" }] },
    { ts: "00:01:00.000", users: [{ username: "Sam's iPhone" }, { username: "Jo Client", email_address: "jo@x.com" }] },
    { ts: "00:21:00.000", users: [{ username: "Jo Client", email_address: "jo@x.com" }] },
  ] };
  assert.deepEqual(zoom.attendance(tl, { hostName: "Sam Lee", internalDomain: "biz.com.au" }), { guestJoined: true, guestMinutes: 20, guests: ["Jo Client"] });
  assert.equal(zoom.attendance(tl, { hostName: null, internalDomain: "biz.com.au" }), null);
  assert.equal(zoom.encodeUuid("/ab//c"), encodeURIComponent(encodeURIComponent("/ab//c")));
});

test("fireflies: only read queries leave", async () => {
  fake(() => ({ json: { data: { transcripts: [] } } }));
  await assert.rejects(fireflies.query("mutation { deleteTranscript(id: \"1\") { id } }"), /only read/);
  assert.deepEqual(await fireflies.listTranscripts(), []);
});

test("meta: key goes in a header, paging links lose any key, leads are never double counted", async () => {
  fake((h) => h.url.includes("after=2") ? { json: { data: [{ ad_id: "2" }] } } : { json: { data: [{ ad_id: "1" }], paging: { next: "https://graph.facebook.com/v21.0/act_1/insights?after=2&access_token=LEAKED" } } });
  const rows = await meta.insights("act_1", { since: "2026-11-01", until: "2026-11-07" });
  assert.ok(hits[0].url.includes("level=account"));
  assert.equal(rows.length, 2);
  assert.ok(hits.every((h) => !h.url.includes("access_token")));
  assert.equal(hits[0].headers.Authorization, "Bearer ADS_SECRET");
  assert.equal(meta.leadCount({ actions: [{ action_type: "offsite_conversion.fb_pixel_lead", value: "3" }, { action_type: "onsite_web_lead", value: "2" }] }), 3);
  assert.equal(meta.leadCount({ actions: [{ action_type: "lead", value: "4" }, { action_type: "onsite_web_lead", value: "9" }] }), 4);
});

test("meta: an inactive test code stops the run, because Meta counted the event as live", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  fake(() => ({ json: { events_received: 1, messages: ["Test event code does not match an active Test Events session"] } }));
  const ev = { event_name: "Lead", event_time: 1, event_id: "e1", user_data: meta.userData({ id: "1", email: "A@B.com" }) };
  await assert.rejects(meta.sendConversions([ev], "TEST1"), /LIVE/);
  assert.equal(ev.user_data.em[0], crypto.createHash("sha256").update("a@b.com").digest("hex"));
});

test("calendly: pages through events and keeps active invitees", async () => {
  fake((h) => h.url.endsWith("/users/me") ? { json: { resource: { uri: "u", email: "o@b.com", current_organization: "https://api.calendly.com/organizations/1" } } }
    : h.url.includes("/invitees") ? { json: { collection: [{ email: "A@x.com ", status: "active" }, { email: "b@x.com", status: "canceled" }] } }
    : h.url.includes("page_token=2") ? { json: { collection: [{ uri: "https://api.calendly.com/scheduled_events/2", name: "Call" }], pagination: {} } }
    : { json: { collection: [{ uri: "https://api.calendly.com/scheduled_events/1", name: "Call" }], pagination: { next_page: "https://api.calendly.com/scheduled_events?page_token=2" } } });
  const b = await calendly.bookings("2026-11-01T00:00:00Z");
  assert.equal(b.length, 2);
  assert.equal(b[0].email, "a@x.com");
});

test("telegram: the bot key never appears in a log line, and long text is split", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  fake(() => ({ json: { ok: true } }));
  assert.equal(await telegram.sendMessage("1", "x".repeat(9000)), 3);
  assert.ok(logs.length === 3 && logs.every((l) => !l.includes("SECRETBOT")));
  fake(() => ({ json: {} }));
  await assert.rejects(telegram.sendMessage("1", "hi"), /not sent/, "no ok:true is not delivered");
});

test("calendar: a meeting link event switches conferencing off and strips an auto-added Meet", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  const { createEvent } = await import("../core/connectors/google-workspace/calendar.ts");
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: "sa@x.iam", private_key: crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
  fake((h) => h.url.includes("oauth2") ? { json: { access_token: "G" } } : h.method === "POST" ? { json: { id: "e1", hangoutLink: "https://meet.google.com/x" } } : { json: { id: "e1" } });
  const ev = await createEvent("rep@biz.com", { summary: "Call", start: "2026-11-10T10:00:00", end: "2026-11-10T10:30:00", meetingUrl: "https://zoom.us/j/1" });
  const post = hits.find((h) => h.method === "POST" && h.url.includes("/events"))!;
  assert.ok(post.url.includes("conferenceDataVersion=1") && JSON.parse(post.body!).conferenceData === null);
  assert.ok(hits.some((h) => h.method === "PATCH"));
  assert.equal(ev.meetUrl, null);
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
});

test("gmail: the sender is split into address and name, as the CRM does", () => {
  assert.deepEqual(gmail.parseFrom('"Jo Smith" <Jo@X.com>'), { email: "jo@x.com", name: "Jo Smith" });
  assert.deepEqual(gmail.parseFrom("jo@x.com"), { email: "jo@x.com", name: "" });
});

test("aircall: searched calls carry a link to the call's page, as the CRM's do", async () => {
  fake(() => ({ json: { calls: [{ id: 41, raw_digits: "+61 400 000 000", started_at: 1 }, { id: 42, raw_digits: "+61 400 000 000", started_at: 9 }, { id: 43, raw_digits: "+61 499 999 999", started_at: 5 }] } }));
  const r = await aircall.searchCalls("0400 000 000");
  assert.deepEqual(r.map((c) => c.id), [42, 41], "near misses dropped, newest first");
  assert.equal(r[0].transcriptUrl, "https://phone.aircall.io/calls/42");
});

test("meta: an ad set is read at ad level and a campaign at campaign level, as the CRM does", async () => {
  fake(() => ({ json: { data: [] } }));
  await meta.insights("123", { nodeType: "adset" });
  await meta.insights("456", { nodeType: "campaign" });
  assert.ok(hits[0].url.includes("level=ad") && hits[1].url.includes("level=campaign"));
  await assert.rejects(meta.insights("789"), /say whether/);
});

test("xero: a 304 to a since-date request means nothing changed", async () => {
  fake((h) => h.url.includes("identity") ? { json: { access_token: "AT", refresh_token: "r1" } } : { status: 304 });
  assert.deepEqual(await xero.listContacts({ modifiedSince: "2026-11-01T00:00:00" }), []);
});

test("aircall: settleMinutes holds back young inbound calls only", async () => {
  fake(() => ({ json: { calls: [{ id: 1, direction: "inbound", started_at: 1000, ended_at: 1100 }, { id: 2, direction: "inbound", started_at: 1000, ended_at: 2500 }, { id: 3, direction: "outbound", started_at: 1950 }], meta: {} } }));
  const r = await aircall.listCalls(0, 2000, { settleMinutes: 25, now: 2000 * 1000 + 600 * 1000 });
  assert.deepEqual(r.map((c) => c.id), [1, 3], "a long inbound call that ended recently is held back");
});

test("telegram: a 200 with ok:false is a failure", async () => {
  process.env.KIT_ALLOW_WRITES = "1";
  fake(() => ({ json: { ok: false, description: "chat not found" } }));
  await assert.rejects(telegram.sendMessage("1", "hi"), /not sent/);
});

test("gmail: a display name goes before the address and cannot break the header", () => {
  const raw = Buffer.from(gmail.rawMessage({ from: "a@b.com", fromName: 'Sam "Boss" <x>', to: "c@d.com", toName: "Jo", subject: "s", text: "t" }), "base64url").toString();
  assert.ok(raw.includes("From: Sam Boss x <a@b.com>") && raw.includes("To: Jo <c@d.com>"));
});
