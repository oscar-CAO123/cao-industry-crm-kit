// GoHighLevel: the client record (notes, tasks), its opportunity (followers, status). Field names from GoHighLevel's official
// spec: NotesDTO, CreateTaskParams, FollowersDTO, UpdateStatusDto, and the note, task and
// task-list response schemas. Reads and internal writes go through ctx.draft; a status change is only ever returned as an Act to queue.
import type { Act, Ctx } from "../../../../../../core/workflows/runtime.ts";
import { checkId, clip, type Note, type Settings, type Task } from "../types.ts";

export const P = "gohighlevel" as const;

export async function getNotes(ctx: Ctx<Settings>, contactId: string): Promise<Note[]> {
  const r = await ctx.draft<{ notes?: Note[] }>({ platform: P, op: "contacts.get-all-notes", summary: "read client notes",
    input: { params: { contactId: checkId(contactId, "contact id") } } });
  return r.data?.notes ?? [];
}

export async function getTasks(ctx: Ctx<Settings>, contactId: string): Promise<Task[]> {
  const r = await ctx.draft<{ tasks?: Task[] }>({ platform: P, op: "contacts.get-all-tasks", summary: "read client tasks",
    input: { params: { contactId: checkId(contactId, "contact id") } } });
  return r.data?.tasks ?? [];
}

/** A note on the client record, written by the owner's user id. Internal: nobody outside the business sees it. */
export async function createNote(ctx: Ctx<Settings>, contactId: string, text: string): Promise<void> {
  await ctx.draft({ platform: P, op: "contacts.create-note", summary: `note on client ${contactId}`,
    input: { params: { contactId: checkId(contactId, "contact id") },
             body: { userId: checkId(ctx.settings.gohighlevel.owner_user_id, "owner user id"), body: clip(text, 4000) } } });
}

/** A follow-up task for one team member. completed is always false when it is created. */
export async function createTask(ctx: Ctx<Settings>, contactId: string,
  t: { title: string; body: string; dueDate: string; assignedTo: string }): Promise<void> {
  await ctx.draft({ platform: P, op: "contacts.create-task", summary: `task on client ${contactId}`,
    input: { params: { contactId: checkId(contactId, "contact id") },
             body: { title: clip(t.title, 200), body: clip(t.body, 1000), dueDate: t.dueDate, completed: false, assignedTo: checkId(t.assignedTo, "user id") } } });
}

/** Adds one team member as a follower on the opportunity, so it shows in their pipeline. */
export async function addFollower(ctx: Ctx<Settings>, opportunityId: string, userId: string): Promise<void> {
  await ctx.draft({ platform: P, op: "opportunities.add-followers-opportunity", summary: `follower on opportunity ${opportunityId}`,
    input: { params: { id: checkId(opportunityId, "opportunity id") }, body: { followers: [checkId(userId, "user id")] } } });
}

/** The status change, as an Act for ctx.queue. It is never called directly: a person approves it in the CRM shell. */
export function statusAct(opportunityId: string, status: string, key: string, lostReasonId?: string): Act {
  const id = checkId(opportunityId, "opportunity id");
  return { platform: P, op: "opportunities.update-opportunity-status", key, summary: `set opportunity ${id} to ${status}`,
    input: { params: { id }, body: { status, ...(lostReasonId ? { lostReasonId: checkId(lostReasonId, "lost reason id") } : {}) } } };
}
