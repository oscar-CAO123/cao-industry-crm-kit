// The departments of every business. The navigation shows one dropdown per department, each with a page of its own
// (the department overview: its pages, its workflows and what waits for approval) and the pages inside it.
// These ids are the workflow folders' department names (industries/<industry>/workflows/<department>/).

export const DEPARTMENTS = [
  { id: "sales", title: "Sales", line: "Enquiries, quotes, pipeline and follow-up." },
  { id: "marketing", title: "Marketing", line: "Content, ads, reviews and landing pages." },
  { id: "customer-service", title: "Customer service", line: "Calls, inboxes, complaints and status updates." },
  { id: "customer-success", title: "Customer success", line: "Onboarding, portals, check-ins and win-back." },
  { id: "fulfilment", title: "Fulfilment", line: "Jobs, scheduling, stock, orders and documents." },
  { id: "finance-admin", title: "Finance and admin", line: "Invoices, bills, reconciliation and the numbers." },
  { id: "people", title: "People", line: "Hiring, rosters, records and training." },
  { id: "compliance-safety", title: "Compliance and safety", line: "Safety forms, checks, expiries and lodgements." },
  { id: "owner", title: "Owner", line: "The numbers, meetings, knowledge and systems health." },
] as const;

export type DepartmentId = (typeof DEPARTMENTS)[number]["id"];
export const DEPARTMENT_IDS = DEPARTMENTS.map((d) => d.id) as readonly string[];
export const isDepartment = (s: string): s is DepartmentId => DEPARTMENT_IDS.includes(s);
export const departmentOf = (id: string) => DEPARTMENTS.find((d) => d.id === id);

/** The CRM's built-in record pages, placed in the department they belong to. Always present, template or not. */
export const BUILT_IN: Record<DepartmentId, { title: string; url: string }[]> = {
  sales: [
    { title: "Leads", url: "/crm/leads" },
    { title: "Opportunities", url: "/crm/opportunities" },
    { title: "Accounts", url: "/crm/accounts" },
    { title: "Contacts", url: "/crm/contacts" },
    { title: "Contracts", url: "/crm/contracts" },
    { title: "Products", url: "/crm/products" },
  ],
  marketing: [],
  "customer-service": [],
  "customer-success": [],
  fulfilment: [
    { title: "Projects", url: "/projects" },
    { title: "Tasks", url: "/crm/tasks" },
    { title: "Documents", url: "/documents" },
  ],
  "finance-admin": [{ title: "Invoices", url: "/invoices" }],
  people: [{ title: "Employees", url: "/employees" }],
  "compliance-safety": [],
  owner: [
    { title: "Approvals", url: "/approvals" },
    { title: "Reports", url: "/reports" },
  ],
};

export const VIEWS = ["board", "table", "calendar", "feed", "dashboard"] as const;
export type View = (typeof VIEWS)[number];
export const FIELD_TYPES = ["text", "textarea", "number", "money", "date", "email", "phone", "select"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface Field { key: string; label: string; type: FieldType; options?: string[] }
export interface TabSpec { slug: string; title: string; view: View; kind: string; stages?: string[]; fields: Field[] }
export interface PageSpec { slug: string; title: string; department: DepartmentId; tabs: TabSpec[] }
