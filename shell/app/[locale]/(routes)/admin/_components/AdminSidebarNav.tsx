"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutTemplate, Users, SlidersHorizontal, ClipboardList, Coins, Receipt } from "lucide-react";

const navItems = [
  { label: "Templates",    href: "/admin/templates",    icon: LayoutTemplate },
  { label: "Users",        href: "/admin/users",        icon: Users },
  { label: "CRM Settings", href: "/admin/crm-settings", icon: SlidersHorizontal },
  { label: "Invoices",     href: "/admin/invoices",     icon: Receipt },
  { label: "Currencies",   href: "/admin/currencies",   icon: Coins },
  { label: "Audit Log",    href: "/admin/audit-log",    icon: ClipboardList },
];

export function AdminSidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      <p className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Admin
      </p>
      {navItems.map(({ label, href, icon: Icon }) => {
        const isActive = pathname.includes(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
