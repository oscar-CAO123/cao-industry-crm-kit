/**
 * Proves the session guards against a mocked better-auth: a PENDING or
 * INACTIVE user is treated as logged out by getSession/requireSession, the
 * raw session still surfaces them for the layout, and requireRole keeps the
 * viewer role off the sending routes.
 */
jest.mock("next/headers", () => ({ headers: jest.fn(async () => new Headers()) }));

const getSessionMock = jest.fn();
jest.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSessionMock(...a) } } }));

import { getSession, getRawSession, requireSession, requireRole } from "@/lib/auth-server";

const user = (userStatus: string, role = "member") => ({ user: { id: "u1", email: "x@example.com", userStatus, role } });

describe("auth-server guards", () => {
  beforeEach(() => getSessionMock.mockReset());

  it("getSession hides PENDING and INACTIVE sessions, keeps ACTIVE", async () => {
    getSessionMock.mockResolvedValueOnce(user("PENDING"));
    expect(await getSession()).toBeNull();
    getSessionMock.mockResolvedValueOnce(user("INACTIVE"));
    expect(await getSession()).toBeNull();
    getSessionMock.mockResolvedValueOnce(null);
    expect(await getSession()).toBeNull();
    getSessionMock.mockResolvedValueOnce(user("ACTIVE"));
    expect((await getSession())?.user.id).toBe("u1");
  });

  it("getRawSession still returns a PENDING session for the layout redirect", async () => {
    getSessionMock.mockResolvedValueOnce(user("PENDING"));
    expect((await getRawSession())?.user.userStatus).toBe("PENDING");
  });

  it("requireSession answers 401 for anything but ACTIVE", async () => {
    getSessionMock.mockResolvedValueOnce(user("PENDING"));
    expect((await requireSession())?.status).toBe(401);
    getSessionMock.mockResolvedValueOnce(user("ACTIVE"));
    expect(await requireSession()).toBeNull();
  });

  it("requireRole: viewer gets 403, member and admin pass, logged out gets 401", async () => {
    getSessionMock.mockResolvedValueOnce(user("ACTIVE", "viewer"));
    expect((await requireRole())?.status).toBe(403);
    getSessionMock.mockResolvedValueOnce(user("ACTIVE", "member"));
    expect(await requireRole()).toBeNull();
    getSessionMock.mockResolvedValueOnce(user("ACTIVE", "admin"));
    expect(await requireRole()).toBeNull();
    getSessionMock.mockResolvedValueOnce(user("INACTIVE", "admin"));
    expect((await requireRole())?.status).toBe(401);
    getSessionMock.mockResolvedValueOnce(user("ACTIVE", "member"));
    expect((await requireRole(["admin"]))?.status).toBe(403);
  });
});
