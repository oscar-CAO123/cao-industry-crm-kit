import FulltextSearch from "./FulltextSearch";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { SetLanguage } from "@/components/SetLanguage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CommandComponent } from "@/components/CommandComponent";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";

const Header = ({ id }: { id: string; lang: string }) => (
  <>
    <div className="flex h-16 shrink-0 items-center justify-between gap-2 px-4 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <FulltextSearch />
      </div>
      <div className="flex items-center gap-2">
        <CommandComponent />
        <SetLanguage userId={id} />
        <CurrencySwitcher />
        <ThemeToggle />
      </div>
    </div>
    <Separator />
  </>
);

export default Header;
