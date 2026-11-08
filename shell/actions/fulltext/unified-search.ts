"use server";
// Search across the CRM by keyword. Active staff only. The shell keeps no embeddings, so nothing is sent to a model.
import { prismadb } from "@/lib/prisma";
import { assertActionSession } from "@/lib/auth-server";

export interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  score: number;
  matchType: "keyword" | "semantic" | "both";
}

export interface UnifiedSearchResults {
  records: SearchResult[];
  accounts: SearchResult[];
  contacts: SearchResult[];
  leads: SearchResult[];
  opportunities: SearchResult[];
  projects: SearchResult[];
  tasks: SearchResult[];
  users: SearchResult[];
  documents: SearchResult[];
}

const hit = (id: string, title: string, subtitle: string, url: string): SearchResult => ({ id, title, subtitle, url, score: 1, matchType: "keyword" });

export async function unifiedSearch(query: string, locale: string = "en"): Promise<UnifiedSearchResults | { error: string }> {
  try { await assertActionSession(); } catch { return { error: "Unauthorized" }; }
  const q = String(query ?? "").trim().slice(0, 100);
  if (q.length < 2) return { error: "Query must be at least 2 characters" };
  const loc = /^[a-z]{2}$/.test(locale) ? locale : "en";
  const has = { contains: q, mode: "insensitive" as const };
  try {
    const [records, pages, accounts, contacts, leads, opportunities, projects, tasks, users, documents] = await Promise.all([
      prismadb.shell_Records.findMany({ where: { deletedAt: null, title: has }, take: 10, select: { id: true, title: true, kind: true, stage: true } }),
      prismadb.shell_Pages.findMany({ select: { department: true, slug: true, spec: true } }),
      prismadb.crm_Accounts.findMany({ where: { deletedAt: null, OR: [{ name: has }, { email: has }, { description: has }] }, take: 10, select: { id: true, name: true, email: true } }),
      prismadb.crm_Contacts.findMany({ where: { deletedAt: null, OR: [{ first_name: has }, { last_name: has }, { email: has }] }, take: 10, select: { id: true, first_name: true, last_name: true, email: true } }),
      prismadb.crm_Leads.findMany({ where: { deletedAt: null, OR: [{ firstName: has }, { lastName: has }, { company: has }, { email: has }] }, take: 10, select: { id: true, firstName: true, lastName: true, company: true, email: true } }),
      prismadb.crm_Opportunities.findMany({ where: { deletedAt: null, OR: [{ name: has }, { description: has }] }, take: 10, select: { id: true, name: true, status: true } }),
      prismadb.boards.findMany({ where: { OR: [{ title: has }, { description: has }] }, take: 10, select: { id: true, title: true, description: true } }),
      prismadb.tasks.findMany({ where: { OR: [{ title: has }, { content: has }] }, take: 10, select: { id: true, title: true, taskStatus: true } }),
      prismadb.users.findMany({ where: { OR: [{ name: has }, { email: has }, { username: has }] }, take: 10, select: { id: true, name: true, email: true } }),
      prismadb.documents.findMany({ where: { parent_document_id: null, OR: [{ document_name: has }, { summary: has }, { description: has }] }, take: 10, select: { id: true, document_name: true, summary: true } }),
    ]);
    // a record's page and tab, from the template pages that hold its kind
    const where = new Map<string, string>();
    for (const p of pages) for (const t of ((p.spec as { tabs?: { slug: string; kind: string }[] })?.tabs ?? [])) if (!where.has(t.kind)) where.set(t.kind, `/${loc}/d/${p.department}/${p.slug}?tab=${t.slug}`);
    return {
      records: records.map((r) => hit(r.id, r.title, [r.kind, r.stage].filter(Boolean).join(" · "), where.get(r.kind) ?? `/${loc}`)),
      accounts: accounts.map((r) => hit(r.id, r.name, r.email ?? "", `/${loc}/crm/accounts/${r.id}`)),
      contacts: contacts.map((r) => hit(r.id, [r.first_name, r.last_name].filter(Boolean).join(" "), r.email ?? "", `/${loc}/crm/contacts/${r.id}`)),
      leads: leads.map((r) => hit(r.id, [r.firstName, r.lastName].filter(Boolean).join(" "), [r.company, r.email].filter(Boolean).join(" · "), `/${loc}/crm/leads/${r.id}`)),
      opportunities: opportunities.map((r) => hit(r.id, r.name ?? "", String(r.status ?? ""), `/${loc}/crm/opportunities/${r.id}`)),
      projects: projects.map((r) => hit(r.id, r.title, r.description ?? "", `/${loc}/projects/boards/${r.id}`)),
      tasks: tasks.map((r) => hit(r.id, r.title, String(r.taskStatus ?? ""), `/${loc}/projects/tasks/viewtask/${r.id}`)),
      users: users.map((r) => hit(r.id, r.name ?? r.email, r.email, `/${loc}/admin/users`)),
      documents: documents.map((r) => hit(r.id, r.document_name, r.summary ?? "", `/${loc}/documents?highlight=${r.id}`)),
    };
  } catch (error) {
    console.error("[UNIFIED_SEARCH]", error instanceof Error ? error.message : "failed");
    return { error: "Search failed" };
  }
}
