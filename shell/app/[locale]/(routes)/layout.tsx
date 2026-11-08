import { getRawSession } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import Header from "./components/Header";
import Footer from "./components/Footer";

import { Metadata } from "next";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "./components/app-sidebar";
import { AvatarProvider } from "@/context/avatar-context";
import { CurrencyProvider } from "@/context/currency-context";
import { getEnabledCurrencies, getDefaultCurrency } from "@/lib/currency";
import { prismadb } from "@/lib/prisma";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL! || "http://localhost:3000"
  ),
  title: "",
  description: "",
  openGraph: {
    images: [
      {
        url: "/images/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    images: [
      {
        url: "/images/opengraph-image.png",
        width: 1200,
        height: 630,
        alt: "",
      },
    ],
  },
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRawSession();

  if (!session) {
    return redirect("/sign-in");
  }

  const user = session?.user;

  if (user?.userStatus === "PENDING") {
    return redirect("/pending");
  }

  if (user?.userStatus === "INACTIVE") {
    return redirect("/inactive");
  }

  // The pages templates added, for the department dropdowns, and what waits for a person.
  const [pages, pendingApprovals] = await Promise.all([
    prismadb.shell_Pages.findMany({ orderBy: { position: "asc" }, select: { department: true, slug: true, title: true } }),
    prismadb.shell_State.count({ where: { ns: "approvals", value: { path: ["status"], equals: "pending" } } }),
  ]);

  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get("sidebar_state")?.value !== "false";

  const enabledCurrencies = await getEnabledCurrencies();
  const defaultCurrency = await getDefaultCurrency();
  const cookieCurrency = cookieStore.get("display_currency")?.value;
  const displayCurrency = cookieCurrency && enabledCurrencies.some((c: { code: string }) => c.code === cookieCurrency)
    ? cookieCurrency
    : defaultCurrency;
  const currencyList = enabledCurrencies.map((c: { code: string; name: string; symbol: string }) => ({ code: c.code, name: c.name, symbol: c.symbol }));

  return (
    <AvatarProvider initialAvatar={user?.image}>
    <CurrencyProvider initialCurrency={displayCurrency} currencies={currencyList}>
    <SidebarProvider defaultOpen={sidebarOpen}>
      <AppSidebar
        appName={process.env.NEXT_PUBLIC_APP_NAME || "CRM"}
        pages={pages}
        pendingApprovals={pendingApprovals}
        session={session}
      />
      <SidebarInset>
        <Header
          id={session.user.id as string}
          lang={session.user.userLanguage as string}
        />
        <div className="flex flex-col flex-grow overflow-y-auto h-full w-full min-w-0">
          <div className="flex-grow py-5 w-full min-w-0">
            <div className="w-full px-4 min-w-0">
              {children}
            </div>
          </div>
          <Footer />
        </div>
      </SidebarInset>
    </SidebarProvider>
    </CurrencyProvider>
    </AvatarProvider>
  );
}
