// Shared shapes for the fulfilment run workflow. The Unleashed adapter speaks these; the crons only read, store and queue.

export interface Settings {
  business_name?: string;
  unleashed: {
    warehouse_code: string;   // the warehouse this business fulfils from
    order_status: string;     // the Unleashed sales order status for orders ready to fulfil
  };
}

export interface OrderLine { line: number; sku: string; qty: number }
export interface Order {
  key: string;                // store key: ord-<order number>
  number: string;             // Unleashed OrderNumber
  guid: string;               // Unleashed Guid of the sales order
  customer: string;
  lines: OrderLine[];
  status: "new" | "short" | "ready" | "queued" | "dispatched" | "failed" | "rejected";
  short?: string[];           // SKUs without enough stock in the warehouse
  dispatch_approval?: string; // approval id once a shipment is queued
  seen: string;
}
export interface Stock { sku: string; available: number }

export const ORDER_NO = /^[A-Za-z0-9._-]{1,40}$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SKU = /^[A-Za-z0-9 ._/+-]{1,100}$/;
export const WAREHOUSE = /^[A-Za-z0-9 _-]{1,15}$/;
export const day = (d: Date) => d.toISOString().slice(0, 10);
export const units = (o: Pick<Order, "lines">) => o.lines.reduce((a, l) => a + l.qty, 0);
