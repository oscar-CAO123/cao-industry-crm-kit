/** Record data is cleaned against the tab's own fields: unknown keys dropped, each value checked against its type. */
jest.mock("@/lib/prisma", () => ({ prismadb: {} }));
import { cleanData, tabOf } from "@/lib/shell/pages";
import type { Field, PageSpec } from "@/lib/shell/departments";

const fields: Field[] = [
  { key: "value", label: "Value", type: "money" }, { key: "due", label: "Due", type: "date" },
  { key: "email", label: "Email", type: "email" }, { key: "kind", label: "Kind", type: "select", options: ["A", "B"] },
  { key: "notes", label: "Notes", type: "textarea" },
];

it("keeps only declared fields and converts money", () => {
  expect(cleanData(fields, { value: "$12,500", due: "2026-11-09", email: "A@B.CO", kind: "A", notes: "x", isAdmin: true, __proto__: { x: 1 } }))
    .toEqual({ value: 12500, due: "2026-11-09", email: "a@b.co", kind: "A", notes: "x" });
});

it.each([[{ value: "lots" }, /number/], [{ due: "9/11/26" }, /date/], [{ email: "nope" }, /email/], [{ kind: "C" }, /options/]])("refuses %j", (input, err) => {
  expect(() => cleanData(fields, input)).toThrow(err);
});

it("caps text length and skips empty values", () => {
  const out = cleanData([{ key: "t", label: "T", type: "text" }], { t: "x".repeat(1000) });
  expect(String(out.t)).toHaveLength(300);
  expect(cleanData(fields, { value: "", notes: null })).toEqual({});
});

it("falls back to the first tab for an unknown tab", () => {
  const page = { slug: "p", title: "P", department: "sales", tabs: [{ slug: "a", title: "A", view: "table", kind: "a", fields: [] }, { slug: "b", title: "B", view: "board", kind: "b", fields: [] }] } as PageSpec;
  expect(tabOf(page, "b").slug).toBe("b");
  expect(tabOf(page, "zzz").slug).toBe("a");
});
