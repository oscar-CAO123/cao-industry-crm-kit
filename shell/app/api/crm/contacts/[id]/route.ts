import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { hasRole, STAFF_ROLES } from "@/lib/security/session-status";
import { prismadb } from "@/lib/prisma";

const FIELD_MAP: Record<string, string> = {
  position:        "position",
  website:         "website",
  social_linkedin: "social_linkedin",
  social_twitter:  "social_twitter",
  social_facebook: "social_facebook",
  social_instagram:"social_instagram",
  description:     "description",
  office_phone:    "office_phone",
  mobile_phone:    "mobile_phone",
};

const URL_FIELDS = new Set(["website", "social_linkedin", "social_twitter", "social_facebook", "social_instagram"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(session.user, STAFF_ROLES)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { enrichmentFields } = await request.json();
  if (!enrichmentFields || typeof enrichmentFields !== "object") {
    return NextResponse.json({ error: "enrichmentFields required" }, { status: 400 });
  }

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(enrichmentFields)) {
    const column = FIELD_MAP[key];
    if (!column) continue;
    const text = String(value).slice(0, 2000);
    // Links are shown as clickable hrefs, so only http(s) addresses are stored.
    if (URL_FIELDS.has(column) && text !== "" && !/^https?:\/\/[^\s]+$/i.test(text)) continue;
    updates[column] = text;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const contact = await prismadb.crm_Contacts.update({
    where: { id },
    data: { ...updates, updatedBy: session.user.id },
    select: { id: true },
  });

  return NextResponse.json({ success: true, id: contact.id });
}
