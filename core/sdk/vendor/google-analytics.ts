import { vendorRequire } from "./load.ts";
import { gatedFetch } from "./gate.ts";
export function googleAnalytics() {
  const { BetaAnalyticsDataClient } = vendorRequire("google-analytics")("@google-analytics/data");
  const auth = { universeDomain: "googleapis.com", getUniverseDomain: async () => "googleapis.com", getProjectId: async () => "kit", getRequestHeaders: async () => ({}), fetch: gatedFetch("google-analytics") };
  return new BetaAnalyticsDataClient({ fallback: true, universeDomain: "googleapis.com", auth, clientConfig: { interfaces: { "google.analytics.data.v1beta.BetaAnalyticsData": { retry_codes: { idempotent: [], non_idempotent: [] } } } } });
}
