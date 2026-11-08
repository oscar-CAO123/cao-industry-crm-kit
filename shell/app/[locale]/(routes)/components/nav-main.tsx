"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type LucideIcon, ChevronRight } from "lucide-react"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarMenuBadge,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export interface NavSubItem { title: string; url: string; exact?: boolean }
export interface NavItem { title: string; url?: string; icon?: LucideIcon; badge?: number; items?: NavSubItem[] }

/** The navigation: plain links, and dropdowns (one per department) whose items are that department's pages. */
export function NavMain({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname().replace(/^\/[a-z]{2}(?=\/|$)/, "") || "/"
  const active = (url: string, exact?: boolean) => (url === "/" || exact ? pathname === url : pathname === url || pathname.startsWith(url + "/"))

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarMenu>
        {items.map((item) =>
          item.items?.length ? (
            <Collapsible key={item.title} asChild defaultOpen={item.items.some((s) => active(s.url, s.exact))} className="group/collapsible">
              <SidebarMenuItem>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={item.title} isActive={item.items.some((s) => active(s.url, s.exact))}>
                    {item.icon && <item.icon />}
                    <span>{item.title}</span>
                    <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {item.items.map((sub) => (
                      <SidebarMenuSubItem key={sub.url}>
                        <SidebarMenuSubButton asChild isActive={active(sub.url, sub.exact)}>
                          <Link href={sub.url}><span>{sub.title}</span></Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          ) : (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton asChild tooltip={item.title} isActive={!!item.url && active(item.url, item.url === "/")}>
                <Link href={item.url ?? "/"}>
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                </Link>
              </SidebarMenuButton>
              {item.badge ? <SidebarMenuBadge>{item.badge}</SidebarMenuBadge> : null}
            </SidebarMenuItem>
          ),
        )}
      </SidebarMenu>
    </SidebarGroup>
  )
}
