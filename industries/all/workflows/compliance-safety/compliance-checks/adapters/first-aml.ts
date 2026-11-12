// First AML: the verification platform that holds a regulated business's cases, checks and screening results.
// Field names come from the vendor's sandbox schema. Every result is a union,
// so each read selects through inline fragments. The kit's document path sends no variables, so every value written
// into a document is checked here first and written as a GraphQL literal.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { CaseRecord, CaseSummary, CheckState, PersonCheck, Settings } from "../types.ts";

const P = "first-aml";
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ORG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR = /^[A-Za-z0-9._=+\/-]{1,500}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const OPEN = new Set(["FAIL", "CONSIDER", "POSSIBLE_MATCH", "MATCH"]);
const WAIT = new Set(["IN_PROGRESS"]);
const CLEAR = new Set(["PASS", "NO_MATCH", "NOT_NEEDED"]);
const SKIP = new Set(["dateVerified", "__typename"]);

const lit = (s: string) => JSON.stringify(s); // GraphQL string literals share JSON's escapes
const ERRORS = "... on ValidationErrors { errors { message fieldPath } }";
const INDIVIDUAL_CHECKS = "legalName dateOfBirth address governmentId idValidity biometric antiTampering pep otherPep sanctions warning fitnessProbity adverseMedia overall";
const ENTITY_CHECKS = "overall sanctions warning fitnessProbity adverseMedia";

export const caseId = (v: unknown) => {
  const s = String(v ?? "");
  if (!CASE_ID.test(s)) throw new Error("first-aml: bad case id");
  return s;
};
const stamp = (v: unknown): string => (typeof v === "string" && STAMP.test(v) ? v : "");

function orgOf(s: Settings): string | undefined {
  const v = s.first_aml?.organization_id;
  if (!v) return undefined;
  if (!ORG_ID.test(v)) throw new Error("first-aml: bad organization id in settings");
  return v;
}

/** The reply body is GraphQL JSON: a transport or GraphQL error, or a ValidationErrors union, stops the read. */
function field(body: any, name: string): any {
  if (body?.errors?.length) throw new Error(`first-aml ${name}: ${String(body.errors[0]?.message ?? "error").slice(0, 160)}`);
  const v = body?.data?.[name];
  if (!v) throw new Error(`first-aml ${name}: no data returned`);
  if (Array.isArray(v.errors)) throw new Error(`first-aml ${name}: ${v.errors.slice(0, 3).map((e: any) => String(e?.message ?? "")).join("; ").slice(0, 300)}`);
  return v;
}

function searchDoc(organizationId: string | undefined, updatedAfter: string, pageSize: number): string {
  const org = organizationId ? `organizationId: ${lit(organizationId)}, ` : "";
  return `query Kit { searchCases(input: {${org}sortField: UPDATED_ON, sortDirection: ASCENDING, updatedAfter: ${lit(updatedAfter)}, pageSize: ${pageSize}}) { ... on PageOfCasesMatchingSearch { hasNextPage nextCursor cases { caseId caseStatus lastUpdatedOn } } ${ERRORS} } }`;
}
function nextPageDoc(cursor: string): string {
  return `query Kit { nextPageOfCases(input: {cursor: ${lit(cursor)}}) { ... on PageOfCasesMatchingSearch { hasNextPage nextCursor cases { caseId caseStatus lastUpdatedOn } } ${ERRORS} } }`;
}
function detailDoc(id: string): string {
  return `query Kit { caseDetails(caseId: ${lit(id)}) { ... on CaseInformation { caseId caseStatus lastUpdatedOn individuals { individualId individualVerificationChecksStatus { ${INDIVIDUAL_CHECKS} dateVerified } } entities { entityId verificationCheckStatus { ${ENTITY_CHECKS} dateVerified } } } ${ERRORS} } }`;
}

function toSummary(c: any): CaseSummary | undefined {
  if (!CASE_ID.test(String(c?.caseId ?? ""))) return undefined;
  return { caseId: String(c.caseId), caseStatus: String(c.caseStatus ?? ""), lastUpdatedOn: stamp(c.lastUpdatedOn) };
}

/** Case summaries updated since a time, oldest first, across at most maxPages pages. Oldest first means a capped read
 *  leaves the cursor at the newest case it read, so no unread case is ever passed over. */
export async function listCases(ctx: Ctx<Settings>, updatedAfter: string, maxPages: number): Promise<CaseSummary[]> {
  if (!stamp(updatedAfter)) throw new Error("first-aml: bad time for the case search");
  const organizationId = orgOf(ctx.settings);
  const out: CaseSummary[] = [];
  let r = await ctx.draft<any>({ platform: P, op: "query.searchCases", summary: "search cases updated since the last run", input: { document: searchDoc(organizationId, updatedAfter, 100), params: { input: { organizationId, updatedAfter, pageSize: 100 } } } });
  let page = field(r.data, "searchCases");
  for (let i = 1; ; i++) {
    for (const c of page.cases ?? []) { const s = toSummary(c); if (s) out.push(s); }
    if (!page.hasNextPage || !page.nextCursor || i >= maxPages) break;
    if (!CURSOR.test(String(page.nextCursor))) throw new Error("first-aml: bad cursor");
    r = await ctx.draft<any>({ platform: P, op: "query.nextPageOfCases", summary: "next page of cases", input: { document: nextPageDoc(String(page.nextCursor)), params: { input: { cursor: String(page.nextCursor) } } } });
    page = field(r.data, "nextPageOfCases");
  }
  return out;
}

/** One person's check results as a state. Any result that needs a person wins over a waiting one; all clear is clear. */
export function personCheck(kind: "individual" | "entity", id: unknown, status: Record<string, unknown> | null | undefined): PersonCheck {
  const rows = Object.entries(status ?? {}).filter(([k, v]) => !SKIP.has(k) && typeof v === "string") as [string, string][];
  const open = rows.filter(([, v]) => OPEN.has(v)).map(([k]) => k);
  const waiting = rows.filter(([, v]) => WAIT.has(v)).map(([k]) => k);
  const state: CheckState = open.length ? "open" : waiting.length ? "waiting"
    : rows.length && rows.every(([, v]) => CLEAR.has(v)) ? "clear" : "unknown";
  return { kind, id: String(id ?? ""), state, open, waiting };
}

/** One case's check state for every individual and entity on it. */
export async function readCase(ctx: Ctx<Settings>, id: string): Promise<CaseRecord> {
  const cid = caseId(id);
  const r = await ctx.draft<any>({ platform: P, op: "query.caseDetails", summary: "read case check state", input: { document: detailDoc(cid), params: { caseId: cid } } });
  const c = field(r.data, "caseDetails");
  const people: PersonCheck[] = [
    ...(c.individuals ?? []).map((i: any) => personCheck("individual", i.individualId, i.individualVerificationChecksStatus)),
    ...(c.entities ?? []).map((e: any) => personCheck("entity", e.entityId, e.verificationCheckStatus)),
  ];
  return {
    caseId: cid, caseStatus: String(c.caseStatus ?? ""), lastUpdatedOn: stamp(c.lastUpdatedOn), people,
    open_count: people.filter((p) => p.state === "open").length, checked: ctx.now.toISOString(),
  };
}

/** The live operation input that adds a note to a case. It is only ever queued; a person approves it. The params name the
 *  required GraphQL arguments for the SDK's check; the document carries the values the server reads. */
export function noteInput(id: string, note: string): { document: string; params: { input: { caseId: string; note: string } } } {
  const cid = caseId(id);
  if (note.length > 1000) throw new Error("first-aml: note too long");
  return { document: `mutation Kit { addCaseNote(input: {caseId: ${lit(cid)}, note: ${lit(note)}}) { ... on CaseInformation { caseId } ${ERRORS} } }`, params: { input: { caseId: cid, note } } };
}
