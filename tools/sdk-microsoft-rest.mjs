// Microsoft publishes JSON REST serializers alongside its older SOAP service definitions.
// Only the two reviewed campaign endpoints are callable. All other operations remain refused.
import fs from "node:fs";
const mapping = JSON.parse(fs.readFileSync(new URL("./sdk-microsoft-rest.json", import.meta.url), "utf8"));
export function mapMicrosoftRest(ops) {
 for (const op of ops) {
  if (!["campaign-management.GetCampaignsByAccountId", "campaign-management.AddCampaigns"].includes(op.id)) {
   op.authUnsupported = "Microsoft REST operation has not passed account-scope review"; continue;
  }
  Object.assign(op, mapping[op.id], { server: "https://campaign.api.bingads.microsoft.com", msadsRest: true,
   summary: `Microsoft Advertising ${op.id.split(".")[1]}`,
   doc_url: `https://learn.microsoft.com/en-us/advertising/campaign-management-service/${op.id.split(".")[1].toLowerCase()}?view=bingads-13`,
   kind: op.id.endsWith("GetCampaignsByAccountId") ? "read" : "write" });
  // Microsoft Learn marks AccountId required for both calls and Campaigns required for AddCampaigns.
  op.params = op.params.map(p => ({...p, required: p.name === "AccountId" || (op.id.endsWith("AddCampaigns") && p.name === "Campaigns")}));
  delete op.authUnsupported;
  if (op.kind === "read") { op.readPost = true; op.override = "read-only Microsoft GetCampaignsByAccountId"; }
 }
}
