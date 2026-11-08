// Bookeo: the class timetable's booking system. Field names come from Bookeo's official OpenAPI spec
// (Product, Slot, Booking, ResourceBlock, and the list wrapper { info, data }).
import type { Ctx } from "../../../../../../core/workflows/runtime.ts";
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import { type Booking, type Product, type RoomBlock, type Settings, type Slot, ID, WHEN, clean } from "../types.ts";

const P = "bookeo";
type Page<T> = { data?: T[] };

const rows = async <T>(ctx: Ctx<Settings>, op: string, params: Record<string, unknown>): Promise<T[]> => {
  const r = await ctx.draft<Page<T>>({ platform: P, op, input: { params: { itemsPerPage: 100, ...params } }, summary: `read ${op}` });
  return (r.data?.data ?? []) as T[];
};
const when = (v: unknown): string => { const s = String(v ?? ""); if (!WHEN.test(s)) throw new Error(`bookeo: bad time ${s.slice(0, 40)}`); return s; };
const id = (v: unknown): string => { const s = String(v ?? ""); if (!ID.test(s)) throw new Error("bookeo: bad id"); return s; };

export const bookeo = {
  id: P,
  products: (ctx: Ctx<Settings>) => rows<Product>(ctx, "get /settings/products", {}),
  slots: (ctx: Ctx<Settings>, from: string, to: string) =>
    rows<Slot>(ctx, "get /availability/slots", { startTime: when(from), endTime: when(to) }),
  bookings: (ctx: Ctx<Settings>, from: string, to: string) =>
    rows<Booking>(ctx, "get /bookings", { startTime: when(from), endTime: when(to), includeCanceled: true }),
  blocks: (ctx: Ctx<Settings>, from: string, to: string) =>
    rows<RoomBlock>(ctx, "get /resourceblocks", { startTime: when(from), endTime: when(to) }),

  /** Cancelling a booking notifies the customer, so it is only ever queued. */
  cancelAct: (bookingNumber: string, reason: string): Act => ({
    platform: P, op: "delete /bookings/{bookingNumber}",
    input: { params: { bookingNumber: id(bookingNumber), notifyCustomer: true, applyCancellationPolicy: false, reason: clean(reason, 120) } },
    summary: `cancel booking ${bookingNumber} and notify the customer`, key: `cancel.${bookingNumber}`,
  }),

  /** Blocking a room changes what members can book, so it is only ever queued. */
  blockAct: (resourceIds: string[], start: string, end: string, reason: string, key: string): Act => ({
    platform: P, op: "post /resourceblocks",
    input: { body: { startTime: when(start), endTime: when(end), reason: clean(reason, 200), resources: resourceIds.map((r) => ({ id: id(r) })) } },
    summary: `block ${resourceIds.length} resource(s) ${start} to ${end}: ${clean(reason, 120)}`, key,
  }),
};
