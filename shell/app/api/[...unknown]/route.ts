import { NextResponse } from "next/server";

/**
 * Any /api path with no route of its own ends here.
 *
 * Without it Next.js resolved an unknown /api/... path to the [locale] pages,
 * with "api" as the locale, so an unknown API path could render a page instead
 * of a 404.
 */
function notFound() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

export const GET = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const HEAD = notFound;
export const OPTIONS = notFound;
