"use server";
// Apply and undo industry templates. Admins only. The preview the admin saw is recomputed on the server before
// writing, so what is applied is always the template in the repo, never a list sent by the browser.
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth-server";
import { apply, undo } from "@/lib/shell/templates";

async function admin() {
  const session = await getSession();
  if (!session || session.user.role !== "admin") throw new Error("Only an admin can change templates");
  return session;
}

export async function applyTemplate(industry: string): Promise<{ ok: boolean; message: string }> {
  try {
    const s = await admin();
    const r = await apply(industry, s.user.id);
    revalidatePath("/", "layout");
    return { ok: true, message: `Applied: ${r.added} pages and workflows switched on.` };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "Could not apply" }; }
}

export async function undoTemplate(applicationId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const s = await admin();
    const r = await undo(applicationId, s.user.id);
    revalidatePath("/", "layout");
    return { ok: true, message: `Undone: ${r.removed} pages and workflows removed. Records entered on those pages are kept.` };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message.slice(0, 200) : "Could not undo" }; }
}
