// Rex Notes create example uses data._related.note_contacts and note_type phonecall.
// An operator records actual call notes in rex-call-notes. Nothing is inferred from an email send.
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";
import { createHash } from "node:crypto";
export async function queueCallNotes(ctx: Ctx<Settings>) {
  if ((ctx.settings.platform ?? "agentbox") !== "rex") return { queued: 0 };
  let queued = 0;
  for (const [key, note] of Object.entries(await ctx.store.list<{ contact_id: string; text: string }>("rex-call-notes"))) {
    if (!/^[1-9]\d{0,11}$/.test(String(note.contact_id)) || typeof note.text !== "string" || !note.text.trim() || note.text.length > 10000) throw new Error("rex: invalid call note");
    const digest = createHash("sha256").update(JSON.stringify([key, note.contact_id, note.text])).digest("hex");
    if (await ctx.store.get("rex-call-notes-queued", digest)) continue;
    const approval = await ctx.queue({ platform: "rex", op: "notes.create", key: `call-note:${digest}`, summary: `Record phone call note on Rex contact ${note.contact_id}: ${note.text}`,
      input: { params: { data: { note: note.text, note_type: { id: "phonecall" }, _related: { note_contacts: [{ contact_id: Number(note.contact_id) }] }, update_last_contacted: false } } },
      check: { platform: "rex", op: "contacts.read", input: { params: { id: Number(note.contact_id) } }, expect: [{ path: "result.id", equals: String(note.contact_id) }] } });
    await ctx.store.put("rex-call-notes-queued", digest, { approval }); queued++;
  }
  return { queued };
}
