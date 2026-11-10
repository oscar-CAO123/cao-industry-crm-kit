import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Test-only endpoint to retrieve captured OTPs for E2E testing
// Only available in non-production environments
export async function GET(request: NextRequest) {
  // Two locks: never in production, and only when a test run turns it on.
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_TEST_OTP !== "1") {
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }

  const email = request.nextUrl.searchParams.get("email");
  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400 });
  }

  try {
    const ctx = await auth.$context;
    const otp = (ctx as any).test?.getOTP(email);
    if (otp) {
      return NextResponse.json({ otp });
    }
    return NextResponse.json({ error: "No OTP found" }, { status: 404 });
  } catch {
    return NextResponse.json({ error: "testUtils not enabled" }, { status: 500 });
  }
}
