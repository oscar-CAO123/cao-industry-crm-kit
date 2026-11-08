// Complaints workflow tests. Every request goes to a fake network: no test reaches a real account.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTransport } from "../core/lib/http.ts";
import { MemoryTokenStore, setTokenStore } from "../core/lib/secrets.ts";
import { MemoryStore } from "../core/workflows/store.ts";
import { context, approve, approvalId, type WorkflowRecord, type Approval } from "../core/workflows/runtime.ts";
import { intake, draft, overdue } from "../industries/all/workflows/customer-service/complaints/index.ts";
import { checkSettings } from "../industries/all/workflows/customer-service/complaints/types.ts";
import fs from "node:fs";

const WF = JSON.parse(fs.readFileSync("industries/all/workflows/customer-service/complaints/workflow.json", "utf8")) as WorkflowRecord;
const NOW = new Date("2026-11-08T00:00:00Z");
const HOUR = 3600e3;

const S: any = {
  business_name: "Test Hire",
  gorgias: { escalate_tag: "needs-human", overdue_tag: "complaint-overdue", category_field_id: 55 },
  categories: [
    { name: "warranty", match: ["warranty", "faulty", "stopped working"],
      ack: "Thanks for letting us know about the fault. We have your details and a team member will be in touch shortly to arrange the next step." },
    { name: "refund", match: ["refund", "money back"],
      ack: "Thanks for your message about a refund. We have your request, and a team member will confirm the next step with you shortly." },
  ],
  escalate: ["injur", "lawyer"],
  lookback_hours: 24, chase_after_hours: 4, signature: "Thanks, Test Hire",
};

type Hit = { method: string; host: string; path: string; query: URLSearchParams; body: any };
let hits: Hit[] = [];

const TICKETS = [
  { id: 601, status: "open", subject: "Warranty fault on the drill", channel: "email", via: "email", created_datetime: "2026-11-07T10:00:00.123456", customer: { id: 90, email: "ann@example.com", name: "Ann" } },
  { id: 602, status: "open", subject: "Refund for order 1002", channel: "email", via: "email", created_datetime: "2026-11-07T11:00:00.000000", customer: { id: 91, email: "bo@example.com", name: "Bo" } },
  { id: 603, status: "open", subject: "Ladder hire", channel: "email", via: "email", created_datetime: "2026-11-07T12:00:00.000000", customer: { id: 92, email: "cy@example.com", name: "Cy" } },
  { id: 604, status: "open", subject: "Opening hours", channel: "email", via: "email", created_datetime: "2026-11-07T13:00:00.000000", customer: { id: 93, email: "di@example.com", name: "Di" } },
  { id: 605, status: "open", subject: "Old refund", channel: "email", via: "email", created_datetime: "2026-10-01T00:00:00.000000", customer: { id: 94 } },
  { id: 606, status: "closed", subject: "Closed warranty", channel: "email", via: "email", created_datetime: "2026-11-07T14:00:00.000000", customer: { id: 95 } },
];
const MESSAGES: Record<string, any[]> = {
  "601": [{ from_agent: false, created_datetime: "2026-11-07T10:00:00", body_text: "The drill stopped working after a week" }],
  "602": [{ from_agent: false, created_datetime: "2026-11-07T11:00:00", body_text: "Please refund me, the hire was cancelled" }],
  "603": [{ from_agent: false, created_datetime: "2026-11-07T12:00:00", body_text: "I was injured when the ladder slipped and I want a lawyer" }],
  "604": [{ from_agent: false, created_datetime: "2026-11-07T13:00:00", body_text: "What time do you open on Saturday?" }],
  "605": [{ from_agent: false, created_datetime: "2026-10-01T00:00:00", body_text: "refund please" }],
};

function fake() {
  hits = [];
  setTransport({
    sleep: async () => {}, log: () => {},
    fetch: (async (url: any, init: any) => {
      const u = new URL(String(url)), m = init?.method ?? "GET", p = u.pathname;
      let body: any; try { body = init?.body ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
      hits.push({ method: m, host: u.host, path: p, query: u.searchParams, body });
      const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
      if (u.host === "acme.gorgias.com") {
        if (p === "/api/tickets" && m === "GET") return json({ data: TICKETS, meta: {} });
        const msgs = p.match(/^\/api\/tickets\/(\d+)\/messages$/);
        if (msgs && m === "GET") return json({ data: MESSAGES[msgs[1]] ?? [], meta: {} });
        if (msgs && m === "POST") return json({ id: 1 }, 201);
        if (/^\/api\/tickets\/\d+\/tags$/.test(p) && m === "POST") return json({ id: 1 }, 201);
        if (/^\/api\/tickets\/\d+\/custom-fields$/.test(p) && m === "PUT") return json([{ id: 55 }]);
        return json({ error: "not faked: " + p }, 404);
      }
      return json({ error: "not faked: " + u.host }, 404);
    }) as any,
  });
}

const ctxOf = (s: MemoryStore, now = NOW) => context(WF, S, s, now, () => {});
const sends = () => hits.filter((h) => h.method === "POST" && /\/messages$/.test(h.path));
const writes = () => hits.filter((h) => h.method !== "GET");

beforeEach(() => {
  fake(); setTokenStore(new MemoryTokenStore());
  Object.assign(process.env, { GORGIAS_EMAIL: "ops@example.com", GORGIAS_API_KEY: "gorgias-test-key",
    GORGIAS_DOMAIN: "acme", KIT_ALLOW_WRITES: "1" });
});

test("intake reads open tickets inside the lookback window, once, and writes nothing", async () => {
  const s = new MemoryStore();
  assert.equal((await intake(ctxOf(s))).added, 4, "601 to 604 are picked up; the old, closed ones are left out");
  assert.equal((await intake(ctxOf(s))).added, 0, "a second run adds nothing");
  assert.equal(writes().length, 0, "intake is read only");
  assert.deepEqual(Object.values(await s.list<any>("enquiries")).map((e: any) => e.status), ["new", "new", "new", "new"]);
});

test("draft tags the escalation, writes the category, queues acknowledgements, parks the rest, and sends nothing", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  const r = await draft(ctxOf(s));
  assert.deepEqual(r, { acknowledgements_queued: 2, escalated: 1, categorised: 0, needs_triage: 1 });
  assert.equal(sends().length, 0, "no message reached a customer during the cron");

  const enq = await s.list<any>("enquiries");
  assert.equal(enq["gorgias:601"].status, "ack-queued");
  assert.equal(enq["gorgias:601"].category, "warranty");
  assert.equal(enq["gorgias:602"].status, "ack-queued");
  assert.equal(enq["gorgias:602"].category, "refund");
  assert.equal(enq["gorgias:603"].status, "escalated");
  assert.match(enq["gorgias:603"].reason, /injur/);
  assert.equal(enq["gorgias:604"].status, "needs-triage");

  const tag = hits.find((h) => h.method === "POST" && h.path === "/api/tickets/603/tags");
  assert.deepEqual(tag?.body, { names: ["needs-human"] }, "the escalated ticket is tagged for a person");
  const field = hits.find((h) => h.method === "PUT" && h.path === "/api/tickets/601/custom-fields");
  assert.deepEqual(field?.body, [{ id: 55, value: "warranty" }], "the category is written into the custom field");

  const pending = Object.values(await s.list<Approval>("approvals"));
  assert.equal(pending.length, 2);
  assert.ok(pending.every((a) => a.status === "pending"));
  const ack = pending.find((a) => a.acts[0].input?.params?.ticket_id === 601)!.acts[0];
  assert.equal(ack.op, "docs.post_tickets_ticket_id_messages");
  assert.match(ack.input?.body?.body_text, /team member/);
  assert.match(ack.input?.body?.body_text, /Thanks, Test Hire/, "the signature is added");
});

test("approval sends each acknowledgement once, and re-runs never queue it again", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  await draft(ctxOf(s));
  const id = approvalId(WF.id, "ack:gorgias:601");

  const a = await approve(WF, s, id, "tester");
  assert.equal(a.status, "done");
  const sent = hits.find((h) => h.method === "POST" && h.path === "/api/tickets/601/messages");
  assert.ok(sent, "acknowledgement sent after approval");
  assert.equal(sent?.body.from_agent, true);
  assert.equal(sent?.body.public, true);
  assert.equal(sent?.body.channel, "email");
  assert.equal(sent?.body.receiver.id, 90);
  assert.match(sent?.body.body_html, /^<p>/);

  assert.equal((await draft(ctxOf(s))).acknowledgements_queued, 0, "a second draft run queues nothing new");
  assert.equal((await intake(ctxOf(s))).added, 0);
  assert.equal(Object.keys(await s.list("approvals")).length, 2, "still two approvals");
  await assert.rejects(approve(WF, s, id, "tester"), /already done/, "an approved acknowledgement cannot be sent twice");
});

test("overdue tags a still-open complaint only after the chase window, and only once", async () => {
  const s = new MemoryStore();
  await intake(ctxOf(s));
  await draft(ctxOf(s));
  const early = new Date("2026-11-07T13:00:00Z");   // 601 is 3 hours old: inside the 4 hour window
  assert.equal((await overdue(ctxOf(s, early))).tagged, 0, "nothing is overdue inside the chase window");
  const later = NOW;                                // every complaint is now more than 4 hours old
  assert.equal((await overdue(ctxOf(s, later))).tagged, 3, "the two acknowledgements and the escalation are still open");
  const tags = hits.filter((h) => h.method === "POST" && /\/tags$/.test(h.path) && h.body?.names?.[0] === "complaint-overdue");
  assert.equal(tags.length, 3);
  assert.equal((await overdue(ctxOf(s, later))).tagged, 0, "a second run tags nothing new");
  assert.ok(!hits.some((h) => h.path === "/api/tickets/604/tags"), "a ticket awaiting triage is not tagged overdue");
});

test("live operations cannot be drafted, and draft operations cannot be queued", async () => {
  const c = ctxOf(new MemoryStore());
  await assert.rejects(c.draft({ platform: "gorgias", op: "docs.post_tickets_ticket_id_messages", summary: "x" }), /not a draft operation/);
  await assert.rejects(c.queue({ platform: "gorgias", op: "docs.post_tickets_ticket_id_tags", summary: "x", input: {} }), /not a live operation/);
  await assert.rejects(c.draft({ platform: "shopify", op: "mutations.refundCreate", summary: "x" }), /not a draft operation/, "a refund is never a draft");
  await assert.rejects(c.draft({ platform: "stripe", op: "openapi_spec3.PostRefunds", summary: "x" }), /not a draft operation/, "a Stripe refund is never a draft");
  assert.equal(writes().length, 0);
});

test("acknowledgements never promise a refund", () => {
  for (const c of S.categories) assert.doesNotMatch(c.ack, /we (will|have) (refund|paid)|refund (has been|is) (issued|processed|paid)/i);
});

test("bad settings fail before any cron touches the platform", () => {
  assert.throws(() => checkSettings({ ...S, categories: [] }), /at least one category/);
  assert.throws(() => checkSettings({ ...S, categories: [{ name: "x", match: ["ok"], ack: "Hi {{ticket.customer.firstname}} we will sort it out" }] }), /acknowledgement/);
  assert.throws(() => checkSettings({ ...S, gorgias: { category_field_id: 0 } }), /positive whole number/);
  assert.throws(() => checkSettings({ ...S, escalate: ["bad*word"] }), /bad escalation word/);
});
