// Shared shapes for the quote-build workflow. The helpers, the shared shapes and the three platform adapters
// (ServiceM8, Xero, Microsoft 365) are reused by relative import from the construction quoting workflow, which is
// never edited from here. This file adds only what this workflow needs: its two call families and its settings.
import type { Ctx } from "../../../../../core/workflows/runtime.ts";
import type { Settings as ReusedSettings } from "../../../../../industries/construction/workflows/sales/quoting/types.ts";

export {
  money, esc, total, cell, sendSummary, quoteHtml, keyOf, day, EMAIL, PHONE,
} from "../../../../../industries/construction/workflows/sales/quoting/types.ts";
export type {
  Adapter, Platform, Contact, Enquiry, Line, Quote, RateItem,
} from "../../../../../industries/construction/workflows/sales/quoting/types.ts";

/** The two ways owners described quoting on the calls (see workflow.json families). */
export type Family = "priced-job-from-site-visit" | "proposal-scope-services";

export interface Settings extends Omit<ReusedSettings, "family"> {
  family: Family;
}

/** The reused adapters are typed against the construction settings. Their fields are the same, so this only changes the type. */
export const reuse = (ctx: Ctx<Settings>) => ctx as unknown as Ctx<ReusedSettings>;
