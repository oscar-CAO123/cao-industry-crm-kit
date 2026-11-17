import { requireAdminPage } from "@/lib/auth-server";
import { prismadb } from "@/lib/prisma";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InvoiceCurrenciesTable } from "./_components/InvoiceCurrenciesTable";

export default async function InvoiceCurrenciesPage() {
  await requireAdminPage(); // admins only: these pages show bank details and business settings
  const currencies = await prismadb.invoice_Currencies.findMany({
    orderBy: { code: "asc" },
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Invoice Currencies</CardTitle>
        </CardHeader>
        <CardContent>
          <InvoiceCurrenciesTable
            currencies={JSON.parse(JSON.stringify(currencies))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
