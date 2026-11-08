import { NextRequest, NextResponse } from "next/server";

/**
 * For a POST that acts with the signed-in user's cookie: refuse anything but a JSON body from this site. A plain HTML form
 * on another site can only send form or text/plain bodies, and a browser always names the page's origin on a cross-site
 * POST. Returns the refusal, or null when the request may go on. A request with no Origin header (a server-side caller) is
 * judged on its Content-Type alone.
 */
export function sameOriginJson(req: NextRequest): NextResponse | null {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return NextResponse.json({ error: "Send JSON" }, { status: 415 });
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* unreadable: refused below */ }
    // Behind a host's proxy the public host can arrive as x-forwarded-host or as host: either one counts as this site.
    const own = [req.headers.get("x-forwarded-host"), req.headers.get("host"), req.nextUrl?.host]
      .flatMap((h) => String(h ?? "").split(",")).map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!host || !own.includes(host.toLowerCase())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}
