// Klaviyo: one campaign, built in Klaviyo with its audience (the lapsed segment), goes out through a send job. The job is queued
// for approval only. Field names: POST /api/campaign-send-jobs, body data {type: "campaign-send-job", id} and the revision header
// (both from Klaviyo's official stable spec; the spec's default revision is 2026-10-15).
import type { Act } from "../../../../../../core/workflows/runtime.ts";
import type { Settings } from "../types.ts";

const P = "klaviyo" as const;
const REVISION = "2026-10-15";
const CAMPAIGN = /^[A-Za-z0-9]{4,40}$/;
const REV = /^\d{4}-\d{2}-\d{2}$/;

export function sendCampaignAct(s: Settings, key: string): Act {
  const id = String(s.klaviyo?.campaign_id ?? "");
  const revision = s.klaviyo?.revision ?? REVISION;
  if (!CAMPAIGN.test(id) || !REV.test(revision)) throw new Error("lead-reactivation: klaviyo campaign_id and revision must be plain values");
  return { platform: P, op: "send_campaign", key, summary: `send Klaviyo campaign ${id} to its audience`,
    input: { params: { revision }, body: { data: { type: "campaign-send-job", id } } } };
}
