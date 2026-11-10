"use client";

import * as React from "react";
import {
  LayoutDashboard, Handshake, Megaphone, Headset, HeartHandshake, Truck, Landmark, Users, ShieldCheck, Crown, CheckCheck, Settings2,
} from "lucide-react";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { NavMain, type NavItem } from "./nav-main";
import { NavUser } from "./nav-user";
import { DEPARTMENTS, BUILT_IN, type DepartmentId } from "@/lib/shell/departments";

const ICONS: Record<DepartmentId, NavItem["icon"]> = {
  sales: Handshake, marketing: Megaphone, "customer-service": Headset, "customer-success": HeartHandshake, fulfilment: Truck,
  "finance-admin": Landmark, people: Users, "compliance-safety": ShieldCheck, owner: Crown,
};

export interface SidebarPage { department: string; slug: string; title: string }

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  appName: string;
  pages: SidebarPage[];
  pendingApprovals: number;
  session: { user: { id: string; name?: string | null; email?: string | null; image?: string | null; role?: string | null } };
}

/** The navigation: Home, then one dropdown per department (its overview, its built-in pages, the pages templates
 *  added), then Approvals and, for admins, Admin (templates, users, audit log). */
export function AppSidebar({ appName, pages, pendingApprovals, session, ...props }: AppSidebarProps) {
  const { state } = useSidebar();
  const departments: NavItem[] = DEPARTMENTS.map((d) => ({
    title: d.title,
    icon: ICONS[d.id],
    items: [
      { title: "Overview", url: `/d/${d.id}`, exact: true },
      ...BUILT_IN[d.id],
      ...pages.filter((p) => p.department === d.id).map((p) => ({ title: p.title, url: `/d/${d.id}/${p.slug}` })),
    ],
  }));
  const top: NavItem[] = [
    { title: "Home", url: "/", icon: LayoutDashboard },
    { title: "Approvals", url: "/approvals", icon: CheckCheck, badge: pendingApprovals },
  ];
  if (session.user.role === "admin") top.push({ title: "Admin", url: "/admin", icon: Settings2 });

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <div className={cn("flex items-center py-1 px-1", state === "expanded" ? "gap-x-3" : "justify-center")}>
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-medium">
            {appName.slice(0, 1).toUpperCase()}
          </span>
          {state === "expanded" && <span className="truncate text-[15px] font-medium">{appName}</span>}
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain label="Workspace" items={top} />
        <NavMain label="Departments" items={departments} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={{ id: session.user.id, name: session.user.name, email: session.user.email, avatar: session.user.image }} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
