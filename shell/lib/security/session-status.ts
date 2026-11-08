/**
 * Session status rules shared by every guard.
 *
 * better-auth issues a session to any user that signs in, including users whose
 * CRM status is PENDING (not yet approved) or INACTIVE (deactivated). Only the
 * page layout used to check that status, so every API route and server action
 * that called getSession() accepted those sessions. These helpers put the rule
 * in one place.
 */

export const STAFF_ROLES = ["admin", "member"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

type UserLike = { userStatus?: string | null; role?: string | null } | null | undefined;

/** True only for an approved, not deactivated user. */
export function isActiveUser(user: UserLike): boolean {
  return !!user && user.userStatus === "ACTIVE";
}

/** True when the user holds one of the given roles (admin, member, viewer). */
export function hasRole(user: UserLike, roles: readonly string[]): boolean {
  return !!user && typeof user.role === "string" && roles.includes(user.role);
}
