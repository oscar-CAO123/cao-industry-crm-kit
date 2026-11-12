import Link from "next/link";
import { notFound } from "next/navigation";
import { prismadb } from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { hasRole, STAFF_ROLES } from "@/lib/security/session-status";
import { departmentOf, isDepartment } from "@/lib/shell/departments";
import { getPage, tabOf } from "@/lib/shell/pages";
import { RecordViews, type Rec } from "@/components/shell/RecordViews";

/** A template page: one core function, its ancillary pieces as tabs. */
export default async function TemplatePage(props: { params: Promise<{ department: string; page: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { department, page: slug } = await props.params;
  const { tab: tabSlug } = await props.searchParams;
  if (!isDepartment(department)) notFound();
  const page = await getPage(department, slug);
  if (!page) notFound();
  const tab = tabOf(page, tabSlug);
  const session = await getSession();
  const rows = await prismadb.shell_Records.findMany({ where: { kind: tab.kind, deletedAt: null }, orderBy: { updatedAt: "desc" }, take: 500 });
  const records: Rec[] = rows.map((r) => ({ id: r.id, title: r.title, stage: r.stage, data: (r.data ?? {}) as Rec["data"], updatedAt: r.updatedAt.toISOString() }));

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/d/${department}`} className="sh-eyebrow hover:underline">{departmentOf(department)!.title}</Link>
        <h1 className="sh-h1">{page.title}</h1>
      </div>
      {page.tabs.length > 1 && (
        <nav className="sh-tabs" aria-label={`${page.title} tabs`}>
          {page.tabs.map((t) => (
            <Link key={t.slug} href={`/d/${department}/${slug}?tab=${t.slug}`} className="sh-tab" aria-current={t.slug === tab.slug ? "page" : undefined}>{t.title}</Link>
          ))}
        </nav>
      )}
      <RecordViews department={department} slug={slug} tab={tab} records={records} canEdit={hasRole(session?.user, STAFF_ROLES)} />
    </div>
  );
}
