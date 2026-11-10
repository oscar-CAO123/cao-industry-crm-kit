import "./globals.css";

import { Jost } from "next/font/google";

import { ReactNode } from "react";

import { NextIntlClientProvider } from "next-intl";
import { getTranslations, getMessages } from "next-intl/server";
import { headers } from "next/headers";

import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/app/providers/ThemeProvider";

const jost = Jost({ subsets: ["latin"], weight: ["300", "400", "500", "600"], variable: "--font-jost" });

type Props = {
  children: ReactNode;
  params: Promise<{ locale: string }>;
};

export async function generateMetadata(props: Props) {
  const params = await props.params;

  const { locale } = params;

  const t = await getTranslations({ locale, namespace: "RootLayout" });

  return {
    metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL!),
    title: t("title"),
    description: t("description"),
    openGraph: {
      images: [
        {
          url: "/images/opengraph-image.png",
          width: 1200,
          height: 630,
          alt: t("title"),
        },
      ],
    },
    twitter: {
      cardType: "summary_large_image",
      image: "/images/opengraph-image.png",
      width: 1200,
      height: 630,
      alt: t("title"),
    },
  };
}

export default async function RootLayout(props: Props) {
  const params = await props.params;

  const { locale } = params;

  const { children } = props;

  const messages = await getMessages();
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={jost.variable + " " + jost.className + " min-h-screen font-sans"}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider attribute="class" defaultTheme="dark" enableSystem nonce={nonce}>
            {children}
          </ThemeProvider>
        </NextIntlClientProvider>
        <Toaster />
        <SonnerToaster />
      </body>
    </html>
  );
}
