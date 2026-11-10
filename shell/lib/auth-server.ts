import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { hasRole, isActiveUser, STAFF_ROLES } from "@/lib/security/session-status";

/**
 * The session exactly as better-auth holds it, whatever the user's CRM status.
 * Only the places that must SEE a pending or deactivated user use this: the
 * app layout (to redirect them) and the /pending and /inactive pages.
 */
export async function getRawSession() {
  return auth.api.getSession({
    headers: await headers(),
  });
}

/**
 * The session of an approved, active user, or null.
 *
 * Every API route and server action that checks "is someone logged in" goes
 * through here, so a PENDING (not yet approved) or INACTIVE (deactivated)
 * user is treated as logged out everywhere at once. Until 24 Oct 2026 only the
 * page layout checked the status, and the 37 API routes plus 160 server
 * actions that used this helper accepted those sessions.
 */
export async function getSession() {
  const session = await getRawSession();
  if (!session || !isActiveUser(session.user)) return null;
  return session;
}

/**
 * Route guard for API endpoints. Returns a 401 NextResponse when there is
 * no active session, or null when the request is authenticated. Usage:
 *
 *   const unauthorized = await requireSession();
 *   if (unauthorized) return unauthorized;
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * Route guard for actions that send, sign or change money on a customer's
 * behalf: needs an active session AND one of the given roles
 * (default admin or member, which excludes the read-only viewer role).
 */
export async function requireRole(
  roles: readonly string[] = STAFF_ROLES,
): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasRole(session.user, roles)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * For server actions: the session of an ACTIVE staff user, or throw.
 *
 * Every export of a "use server" file can be called from any browser with any
 * arguments, so a page's login gate does not cover it. Each one checks for itself.
 */
export async function assertActionSession() {
  const session = await getSession();
  if (!session || !hasRole(session.user, STAFF_ROLES)) throw new Error("Unauthorized");
  return session;
}
