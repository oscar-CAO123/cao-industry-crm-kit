import { getTranslations } from "next-intl/server";

import "@/app/[locale]/globals.css";
import { ThemeToggle } from "@/components/ThemeToggle";
import Footer from "@/app/[locale]/(routes)/components/Footer";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata(props: Props) {
  const { locale } = await props.params;
  const t = await getTranslations({ locale, namespace: "RootLayout" });
  return { title: t("title"), description: t("description") };
}

const AuthLayout = ({ children }: { children: React.ReactNode }) => (
  <div className="flex min-h-screen w-full flex-col items-center justify-center">
    <div className="flex w-full items-center justify-end p-5">
      <ThemeToggle />
    </div>
    <div className="flex h-full grow items-center overflow-hidden">{children}</div>
    <Footer />
  </div>
);

export default AuthLayout;
