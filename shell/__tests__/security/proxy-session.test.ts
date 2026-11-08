/**
 * The proxy lets a CRM page through only for a real, ACTIVE session. A session
 * cookie that merely exists is not enough: the page renders in parallel with
 * the layout, so the layout's redirect still streamed the page's data.
 */
import { NextRequest, NextResponse } from "next/server";

const getSession = jest.fn();
let cookie: string | null = null;
jest.mock("@/i18n/routing", () => ({ routing: { locales: ["en", "cz", "de", "uk"] } }));
jest.mock("next-intl/middleware", () => ({ __esModule: true, default: () => () => NextResponse.next() }));
jest.mock("better-auth/cookies", () => ({ getSessionCookie: () => cookie }));
jest.mock("@/lib/auth", () => ({ auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } } }));

import { proxy } from "@/proxy";

const page = (path: string) =>
  new NextRequest("https://crm.example.com" + path, { headers: { host: "crm.example.com" } });
const location = (res: Response) => new URL(res.headers.get("location") ?? "http://x/").pathname;

beforeEach(() => {
  cookie = null;
  getSession.mockReset().mockResolvedValue(null);
});

it("sends a visitor with no cookie to sign-in", async () => {
  const res = await proxy(page("/en/crm/leads"));
  expect(location(res)).toBe("/sign-in");
  expect(getSession).not.toHaveBeenCalled();
});

it("sends a made-up cookie to sign-in", async () => {
  cookie = "fake";
  expect(location(await proxy(page("/en/crm/leads")))).toBe("/sign-in");
});

it("sends a session that fails to load to sign-in", async () => {
  cookie = "real";
  getSession.mockRejectedValue(new Error("db down"));
  expect(location(await proxy(page("/en/d/sales")))).toBe("/sign-in");
});

it("sends PENDING to /pending and INACTIVE to /inactive", async () => {
  cookie = "real";
  getSession.mockResolvedValue({ user: { id: "u", userStatus: "PENDING" } });
  expect(location(await proxy(page("/en/crm/leads")))).toBe("/pending");
  getSession.mockResolvedValue({ user: { id: "u", userStatus: "INACTIVE" } });
  expect(location(await proxy(page("/en/crm/leads")))).toBe("/inactive");
});

it("lets an ACTIVE session through", async () => {
  cookie = "real";
  getSession.mockResolvedValue({ user: { id: "u", userStatus: "ACTIVE" } });
  const res = await proxy(page("/en/crm/leads"));
  expect(res.headers.get("location")).toBeNull();
  expect(res.status).toBe(200);
});

it("leaves the sign-in page open", async () => {
  const res = await proxy(page("/en/sign-in"));
  expect(res.headers.get("location")).toBeNull();
});

it.each(["/en/crm/leads/sign-in-x/", "/en/d/sales/x/sign-in", "/en/book/abc", "/ai-readiness"])("does not treat %s as public", async (p) => {
  expect(location(await proxy(page(p)))).toBe("/sign-in");
});

it.each(["/en/pending", "/en/inactive", "/sign-in"])("keeps %s open", async (p) => {
  expect((await proxy(page(p))).headers.get("location")).toBeNull();
});

it("refuses an API call with no cookie and lets the sign-in API through", async () => {
  expect((await proxy(page("/api/reports/export"))).status).toBe(401);
  expect((await proxy(page("/api/auth/get-session"))).status).toBe(200);
});

it("puts the security headers and a nonce CSP on a page", async () => {
  cookie = "real";
  getSession.mockResolvedValue({ user: { id: "u", userStatus: "ACTIVE" } });
  const res = await proxy(page("/en/d/sales"));
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("strict-transport-security")).toMatch(/max-age=31536000/);
  expect(res.headers.get("content-security-policy")).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(res.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
});

describe("dotted paths", () => {
  it.each(["/en/crm/leads/abc.x", "/x.y/d/sales", "/en/d/sales/1.json", "/tmp/data.json", "/x.png"])("sends %s with no session to sign-in", async (path) => {
    expect(location(await proxy(page(path)))).toBe("/sign-in");
  });

  it.each(["/_next/static/chunks/a.js", "/favicon.ico", "/fonts/jost/jost-normal-400.ttf", "/images/x.png"])("still serves the static file %s", async (path) => {
    expect((await proxy(page(path))).headers.get("location")).toBeNull();
  });
});
