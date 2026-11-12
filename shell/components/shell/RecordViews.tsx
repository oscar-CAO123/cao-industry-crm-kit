"use client";
// One tab of a template page, drawn in its view. Views follow one grammar: a board of stage lanes
// for anything that moves through steps, a table for lists, a week for anything with a date, a feed for incoming
// messages and calls, and a numbers page. Every change goes through actions/shell/records.ts.
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { createRecord, updateRecord, deleteRecord } from "@/actions/shell/records";
import type { TabSpec, Field } from "@/lib/shell/departments";

export interface Rec { id: string; title: string; stage: string | null; data: Record<string, string | number>; updatedAt: string }

const money = (n: unknown) => (typeof n === "number" ? n.toLocaleString(undefined, { style: "currency", currency: "AUD", maximumFractionDigits: 0 }) : "");
const show = (f: Field, v: unknown) => (v === undefined || v === "" ? "" : f.type === "money" ? money(v) : String(v));

export function RecordViews({ department, slug, tab, records, canEdit }: { department: string; slug: string; tab: TabSpec; records: Rec[]; canEdit: boolean }) {
  const [editing, setEditing] = useState<Rec | "new" | null>(null);
  const [newStage, setNewStage] = useState<string | undefined>(undefined);
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (p: Promise<{ ok: boolean; error?: string }>, done?: () => void) =>
    start(async () => { const r = await p; if (!r.ok) toast.error(r.error ?? "Could not save"); else { done?.(); router.refresh(); } });
  const move = (r: Rec, stage: string) => run(updateRecord(department, slug, tab.slug, r.id, { stage }));
  const open = (r: Rec | "new", stage?: string) => { setNewStage(stage); setEditing(r); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{records.length} {records.length === 1 ? "record" : "records"}</span>
        <div className="flex-1" />
        {canEdit && tab.view !== "dashboard" && <Button size="sm" onClick={() => open("new")}>Add</Button>}
      </div>
      {records.length === 0 && tab.view !== "dashboard" ? (
        <div className="sh-card text-sm text-muted-foreground">
          Nothing here yet. Records arrive when someone adds one, or when this department&apos;s workflows draft them from the business&apos;s connected apps.
        </div>
      ) : tab.view === "board" ? (
        <Board tab={tab} records={records} canEdit={canEdit} onOpen={open} onMove={move} />
      ) : tab.view === "calendar" ? (
        <Week tab={tab} records={records} onOpen={open} />
      ) : tab.view === "feed" ? (
        <Feed tab={tab} records={records} onOpen={open} />
      ) : tab.view === "dashboard" ? (
        <Numbers tab={tab} records={records} />
      ) : (
        <Table tab={tab} records={records} onOpen={open} />
      )}
      {editing && (
        <RecordForm
          tab={tab} rec={editing === "new" ? null : editing} canEdit={canEdit} busy={pending}
          onClose={() => setEditing(null)}
          onSave={(title, data, stage) => run(editing === "new" ? createRecord(department, slug, tab.slug, title, data, stage ?? newStage) : updateRecord(department, slug, tab.slug, editing.id, { title, data, stage }), () => setEditing(null))}
          onDelete={editing === "new" ? undefined : () => run(deleteRecord(department, slug, tab.slug, (editing as Rec).id), () => setEditing(null))}
        />
      )}
    </div>
  );
}

function Board({ tab, records, canEdit, onOpen, onMove }: { tab: TabSpec; records: Rec[]; canEdit: boolean; onOpen: (r: Rec | "new", s?: string) => void; onMove: (r: Rec, s: string) => void }) {
  const stages = tab.stages ?? ["Open"];
  const money = tab.fields.find((f) => f.type === "money");
  return (
    <div className="sh-lanes">
      {stages.map((s) => {
        const inLane = records.filter((r) => (r.stage ?? stages[0]) === s);
        const total = money ? inLane.reduce((a, r) => a + (Number(r.data[money.key]) || 0), 0) : 0;
        return (
          <div key={s} className="sh-lane">
            <div className="flex items-baseline gap-2 px-1">
              <span className="text-sm font-medium">{s}</span>
              <span className="text-xs text-muted-foreground">{inLane.length}{money && total ? ` · ${total.toLocaleString(undefined, { style: "currency", currency: "AUD", maximumFractionDigits: 0 })}` : ""}</span>
              <div className="flex-1" />
              {canEdit && <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => onOpen("new", s)}>+ Add</button>}
            </div>
            {inLane.map((r) => (
              <div key={r.id} className="rounded-xl border bg-card p-3 text-sm">
                <button className="w-full text-left font-medium hover:underline" onClick={() => onOpen(r)}>{r.title}</button>
                <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {tab.fields.slice(0, 3).map((f) => r.data[f.key] !== undefined && <div key={f.key}>{f.label}: {show(f, r.data[f.key])}</div>)}
                </div>
                {canEdit && (
                  <select aria-label="Move to stage" className="mt-2 w-full rounded-md border bg-background px-2 py-1 text-xs" value={r.stage ?? stages[0]} onChange={(e) => onMove(r, e.target.value)}>
                    {stages.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function Table({ tab, records, onOpen }: { tab: TabSpec; records: Rec[]; onOpen: (r: Rec) => void }) {
  return (
    <div className="sh-card overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead><tr className="border-b text-left text-muted-foreground">
          <th className="px-4 py-2.5 font-normal">Name</th>
          {tab.fields.map((f) => <th key={f.key} className="px-4 py-2.5 font-normal">{f.label}</th>)}
        </tr></thead>
        <tbody>
          {records.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-accent">
              <td className="px-4 py-2.5"><button className="font-medium hover:underline" onClick={() => onOpen(r)}>{r.title}</button></td>
              {tab.fields.map((f) => <td key={f.key} className="px-4 py-2.5 text-muted-foreground">{show(f, r.data[f.key])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Week({ tab, records, onOpen }: { tab: TabSpec; records: Rec[]; onOpen: (r: Rec) => void }) {
  const [offset, setOffset] = useState(0);
  const dateKey = tab.fields.find((f) => f.type === "date")?.key ?? "date";
  const days = useMemo(() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7);
    return Array.from({ length: 7 }, (_, i) => { const x = new Date(d); x.setDate(d.getDate() + i); return x; });
  }, [offset]);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const undated = records.filter((r) => !r.data[dateKey]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setOffset(offset - 1)}>Previous week</Button>
        <Button size="sm" variant="outline" onClick={() => setOffset(0)}>This week</Button>
        <Button size="sm" variant="outline" onClick={() => setOffset(offset + 1)}>Next week</Button>
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(7, minmax(120px, 1fr))", overflowX: "auto" }}>
        {days.map((d) => (
          <div key={iso(d)} className="sh-lane min-h-[180px]">
            <div className="px-1 text-xs text-muted-foreground">{d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}</div>
            {records.filter((r) => r.data[dateKey] === iso(d)).map((r) => (
              <button key={r.id} onClick={() => onOpen(r)} className="rounded-lg border bg-card p-2 text-left text-xs hover:underline">
                {r.data.time ? <span className="text-muted-foreground">{String(r.data.time)} </span> : null}{r.title}
              </button>
            ))}
          </div>
        ))}
      </div>
      {undated.length > 0 && <Table tab={tab} records={undated} onOpen={onOpen} />}
    </div>
  );
}

function Feed({ tab, records, onOpen }: { tab: TabSpec; records: Rec[]; onOpen: (r: Rec) => void }) {
  const sorted = [...records].sort((a, b) => String(b.data.date ?? b.updatedAt).localeCompare(String(a.data.date ?? a.updatedAt)));
  return (
    <div className="space-y-2">
      {sorted.map((r) => (
        <button key={r.id} onClick={() => onOpen(r)} className="sh-card block w-full text-left hover:bg-accent">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{r.title}</span>
            {r.data.channel ? <span className="sh-pill">{String(r.data.channel)}</span> : null}
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">{String(r.data.date ?? r.updatedAt.slice(0, 10))}</span>
          </div>
          {r.data.from ? <div className="text-sm text-muted-foreground">{String(r.data.from)}</div> : null}
          {r.data.notes ? <div className="mt-1 line-clamp-2 text-sm">{String(r.data.notes)}</div> : null}
        </button>
      ))}
      {tab.fields.length === 0 && null}
    </div>
  );
}

function Numbers({ tab, records }: { tab: TabSpec; records: Rec[] }) {
  const amount = tab.fields.find((f) => f.type === "money")?.key;
  const total = amount ? records.reduce((a, r) => a + (Number(r.data[amount]) || 0), 0) : 0;
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = records.filter((r) => String(r.data.date ?? r.updatedAt).startsWith(month));
  return (
    <div className="sh-stats">
      <div className="sh-stat"><div className="sh-stat-v">{records.length}</div><div className="sh-stat-l">Entries</div></div>
      <div className="sh-stat"><div className="sh-stat-v">{thisMonth.length}</div><div className="sh-stat-l">This month</div></div>
      {amount && <div className="sh-stat"><div className="sh-stat-v">{money(total)}</div><div className="sh-stat-l">Total</div></div>}
      <div className="sh-stat sm:col-span-2"><div className="sh-stat-l">Where these numbers come from</div><div className="mt-1 text-sm text-muted-foreground">This page fills from the business&apos;s accounts once its finance workflows are connected and running. Until then it counts what is entered here.</div></div>
    </div>
  );
}

function RecordForm({ tab, rec, canEdit, busy, onClose, onSave, onDelete }: {
  tab: TabSpec; rec: Rec | null; canEdit: boolean; busy: boolean; onClose: () => void;
  onSave: (title: string, data: Record<string, string>, stage?: string) => void; onDelete?: () => void;
}) {
  const [title, setTitle] = useState(rec?.title ?? "");
  const [stage, setStage] = useState<string | undefined>(rec?.stage ?? undefined);
  const [data, setData] = useState<Record<string, string>>(Object.fromEntries(Object.entries(rec?.data ?? {}).map(([k, v]) => [k, String(v)])));
  const set = (k: string, v: string) => setData((d) => ({ ...d, [k]: v }));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{rec ? rec.title : `New: ${tab.title}`}</DialogTitle></DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(title, data, stage); }}>
          <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Name</span>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} disabled={!canEdit} /></label>
          {tab.stages && rec && (
            <label className="block space-y-1 text-sm"><span className="text-muted-foreground">Stage</span>
              <select className="w-full rounded-md border bg-background px-3 py-2" value={stage ?? tab.stages[0]} onChange={(e) => setStage(e.target.value)} disabled={!canEdit}>
                {tab.stages.map((s) => <option key={s} value={s}>{s}</option>)}
              </select></label>
          )}
          {tab.fields.map((f) => (
            <label key={f.key} className="block space-y-1 text-sm"><span className="text-muted-foreground">{f.label}</span>
              {f.type === "textarea" ? (
                <Textarea value={data[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} maxLength={5000} disabled={!canEdit} />
              ) : f.type === "select" ? (
                <select className="w-full rounded-md border bg-background px-3 py-2" value={data[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} disabled={!canEdit}>
                  <option value="" />{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <Input type={f.type === "date" ? "date" : f.type === "number" || f.type === "money" ? "number" : f.type === "email" ? "email" : f.type === "phone" ? "tel" : "text"}
                  step={f.type === "money" ? "0.01" : undefined} value={data[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} maxLength={300} disabled={!canEdit} />
              )}
            </label>
          ))}
          <DialogFooter className="gap-2">
            {onDelete && canEdit && <Button type="button" variant="ghost" className="mr-auto text-destructive" disabled={busy} onClick={() => confirm("Delete this record?") && onDelete()}>Delete</Button>}
            <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            {canEdit && <Button type="submit" disabled={busy}>{busy ? "Saving" : "Save"}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
