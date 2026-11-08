/**
 * Industry templates: preview lists every change, apply writes exactly that list in one transaction, a second apply
 * adds nothing, undo removes only what the template added (a workflow that was on before stays on), and nothing is
 * ever a record. Runs against an in-memory stand-in for the database and the real template files in the repo.
 */
import path from "node:path";

type Row = Record<string, any>;
const db = { pages: [] as Row[], workflows: [] as Row[], apps: [] as Row[], audit: [] as Row[], records: [] as Row[] };
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const match = (r: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => r[k] === v);
const tx = {
  shell_Pages: {
    findMany: async () => db.pages.map((p) => ({ ...p })),
    create: async ({ data }: any) => { const r = { id: id(), ...data }; db.pages.push(r); return r; },
    aggregate: async () => ({ _max: { position: db.pages.reduce((a, p) => Math.max(a, p.position), 0) || null } }),
    deleteMany: async ({ where }: any) => { const before = db.pages.length; db.pages = db.pages.filter((p) => !match(p, where)); return { count: before - db.pages.length }; },
  },
  shell_Workflows: {
    findMany: async () => db.workflows.map((w) => ({ ...w })),
    create: async ({ data }: any) => { db.workflows.push({ ...data }); return data; },
    update: async ({ where, data }: any) => { const w = db.workflows.find((x) => x.id === where.id)!; Object.assign(w, data); return w; },
    updateMany: async ({ where, data }: any) => { const l = db.workflows.filter((w) => match(w, where)); l.forEach((w) => Object.assign(w, data)); return { count: l.length }; },
    deleteMany: async ({ where }: any) => { const before = db.workflows.length; db.workflows = db.workflows.filter((w) => !match(w, where)); return { count: before - db.workflows.length }; },
  },
  shell_TemplateApplications: {
    create: async ({ data }: any) => { const r = { id: id(), status: "applied", ...data }; db.apps.push(r); return r; },
    update: async ({ where, data }: any) => { const r = db.apps.find((a) => a.id === where.id)!; Object.assign(r, data); return r; },
    findUnique: async ({ where }: any) => db.apps.find((a) => a.id === where.id) ?? null,
    findFirst: async ({ where }: any) => db.apps.filter((a) => match(a, where)).at(-1) ?? null,
  },
  shell_Records: { create: async () => { throw new Error("a template must never write a record"); } },
  crm_AuditLog: { create: async ({ data }: any) => { db.audit.push(data); return data; } },
};
jest.mock("@/lib/prisma", () => ({ prismadb: { ...tx, $transaction: (fn: any) => fn(tx) } }));

process.env.KIT_ROOT = path.resolve(__dirname, "../../..");
import { preview, apply, undo } from "@/lib/shell/templates";
import { listIndustries, loadTemplate } from "@/lib/shell/kit";

beforeEach(() => { db.pages = []; db.workflows = []; db.apps = []; db.audit = []; });

it("has a valid template for all 13 industries, each naming only workflows that exist", () => {
  const all = listIndustries();
  expect(all).toHaveLength(13);
  for (const i of all) {
    const t = loadTemplate(i);
    expect(t.pages.length).toBeGreaterThan(5);
    expect(t.workflows.length).toBeGreaterThan(5);
    expect(Object.keys(t)).not.toContain("records");
  }
});

it("previews, applies once, then reports everything as already on", async () => {
  const p = await preview("construction");
  const adds = p.changes.filter((c) => c.state === "add");
  expect(adds.length).toBe(p.changes.length);
  const r = await apply("construction", "user-1");
  expect(r.added).toBe(adds.length);
  expect(db.pages.length).toBe(p.changes.filter((c) => c.type === "page").length);
  expect(db.audit.at(-1)).toMatchObject({ entityType: "template", action: "applied" });
  const again = await preview("construction");
  expect(again.changes.every((c) => c.state === "already-on")).toBe(true);
  expect((await apply("construction", "user-1")).added).toBe(0);
});

it("undo removes exactly what it added and keeps a workflow that was on before", async () => {
  const t = loadTemplate("construction");
  const before = t.workflows[0];
  db.workflows.push({ id: before.id, dir: before.dir, department: before.department, name: before.name, status: before.status, enabled: true, applicationId: null });
  const r = await apply("construction", "user-1");
  expect(db.workflows.find((w) => w.id === before.id)?.applicationId).toBeNull();
  await undo(r.id, "user-1");
  expect(db.pages).toHaveLength(0);
  expect(db.workflows).toEqual([expect.objectContaining({ id: before.id, enabled: true })]);
  expect(db.apps[0].status).toBe("undone");
  await expect(undo(r.id, "user-1")).rejects.toThrow(/no applied template/);
});

it("switches a workflow that was off back on, and off again on undo", async () => {
  const w = loadTemplate("retail").workflows[0];
  db.workflows.push({ id: w.id, dir: w.dir, department: w.department, name: w.name, status: w.status, enabled: false, applicationId: null });
  const r = await apply("retail", "u");
  expect(db.workflows.find((x) => x.id === w.id)?.enabled).toBe(true);
  await undo(r.id, "u");
  expect(db.workflows.find((x) => x.id === w.id)).toMatchObject({ enabled: false, applicationId: null });
});

it("refuses a made-up industry", async () => {
  await expect(preview("../core")).rejects.toThrow();
  await expect(apply("not-an-industry", "u")).rejects.toThrow();
});
