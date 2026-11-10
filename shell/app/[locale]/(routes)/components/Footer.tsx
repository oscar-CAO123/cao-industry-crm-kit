import { version } from "@/package.json";

const Footer = () => (
  <footer className="flex h-8 w-full items-center justify-end p-5 text-xs text-muted-foreground">
    <span className="hidden md:inline">{process.env.NEXT_PUBLIC_APP_NAME || "CRM"} v{version}</span>
  </footer>
);

export default Footer;
