// Shared shapes for the email flows workflow. The Klaviyo adapter speaks these.
export interface Settings {
  business_name?: string;
  klaviyo: {
    conversion_metric_id: string;                                  // the conversion metric the flows page uses
    timeframe?: "last_7_days" | "last_30_days" | "last_90_days";
    target_conversion_rate?: number;                               // fraction, for example 0.02
    min_recipients?: number;                                       // a flow with fewer recipients is not judged
  };
}

/** Klaviyo ids are short alphanumeric strings (for example XVTP5Q). Anything else is refused before it reaches a path. */
export const ID = /^[A-Za-z0-9]{1,64}$/;

export interface FlowRow {
  id: string; name: string; status: string;
  recipients: number; conversions: number; conversion_rate: number; revenue: number;
}
export interface Scorecard { taken: string; timeframe: string; target: number; flows: FlowRow[] }
export interface Sprint { flow_id: string; flow_name: string; opened: string; reason: string; action_ids: string[] }
/** Written by the owner (through the store) when a draft replacement flow is ready to go live. Keyed by the draft's flow id. */
export interface ReadyFlow { flow_id: string; marked_by: string; marked: string }
