// Every request passes through here. The shell has no public pages: only sign-in, the pending and inactive notices,
// the sign-in API and static files are reachable without a session. A page needs a real, ACTIVE session, checked here
// before it renders (a page streams in parallel with its layout, so a redirect in the layout alone would still leak
// the page's data). API routes and server actions check an active session again themselves (lib/auth-server.ts).
// Every response carries the security headers, including a per-request nonce Content-Security-Policy.
import createMiddleware from "next-intl/middleware";
import { getSessionCookie } from "better-auth/cookies";
import { auth } from "@/lib/auth";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";

const intl = createMiddleware(routing);
const LOCALE = `(?:${routing.locales.join("|")})`;
const OPEN_PAGE = new RegExp(`^/(?:${LOCALE}/)?(?:sign-in|pending|inactive)(?:/.*)?$`);
const STATIC = /^\/(?:_next\/static\/|_next\/image|favicon\.ico$|robots\.txt$|images\/|fonts\/)/;

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
}

export function csp(n: string, dev = process.env.NODE_ENV === "development"): string {
  const files = process.env.FILES_PUBLIC_ORIGIN ? ` ${process.env.FILES_PUBLIC_ORIGIN}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${n}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${files} https://lh3.googleusercontent.com`,
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export function secure(res: NextResponse, policy?: string): NextResponse {
  res.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (policy) res.headers.set("Content-Security-Policy", policy);
  return res;
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  if (STATIC.test(path)) return secure(NextResponse.next());
  if (path.startsWith("/api/auth/")) return secure(NextResponse.next());
  // The scheduler trigger checks its own bearer token (app/api/workflows/run/route.ts); it never carries a session.
  if (path === "/api/workflows/run" && (req.method === "POST" || req.method === "GET")) return secure(NextResponse.next());

  const signedIn = !!getSessionCookie(req);
  if (path.startsWith("/api/")) {
    if (!signedIn) return secure(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    return secure(NextResponse.next());
  }
  if (!OPEN_PAGE.test(path)) {
    const session = signedIn ? await auth.api.getSession({ headers: req.headers }).catch(() => null) : null;
    const status = (session?.user as { userStatus?: string } | undefined)?.userStatus;
    const to = !session ? "/sign-in" : status === "PENDING" ? "/pending" : status === "INACTIVE" ? "/inactive" : status === "ACTIVE" ? null : "/sign-in";
    if (to) return secure(NextResponse.redirect(new URL(to, req.nextUrl)));
  }

  const n = nonce();
  const policy = csp(n);
  const headers = new Headers(req.headers);
  headers.set("x-nonce", n);
  headers.set("content-security-policy", policy);
  return secure(intl(new NextRequest(req, { headers })), policy);
}

export const config = {
  matcher: ["/:path*"],
};
