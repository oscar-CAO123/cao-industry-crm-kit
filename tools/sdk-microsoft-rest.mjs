// Microsoft publishes JSON REST routes for every Bing Ads API v13 operation (tools/sdk-microsoft-rest.json, read from its
// generated REST client). The kit works inside ONE configured ad account: the CustomerAccountId and CustomerId headers are
// pinned to MSADS_ACCOUNT_ID and MSADS_CUSTOMER_ID, and core/sdk/microsoft-scope.ts refuses any account or customer ID in a
// request that is not those two. Campaign Management and Reporting run inside that boundary. Customer Management is account
// administration (users, sign-up, client links, other customers); only reads of the configured account and customer run.
import fs from "node:fs";
const mapping = JSON.parse(fs.readFileSync(new URL("./sdk-microsoft-rest.json", import.meta.url), "utf8"));

// Production REST hosts, from each operation's Microsoft Learn page (Request Url, Production URL tab).
const HOSTS = {
 "campaign-management": "https://campaign.api.bingads.microsoft.com",
 "customer-management": "https://clientcenter.api.bingads.microsoft.com",
 "reporting": "https://reporting.api.bingads.microsoft.com",
};
// Customer Management reads whose only selectors are the configured account or customer (or none, for the signed-in user).
const CUSTOMER_READS = new Set(["GetAccount", "GetCustomer", "GetAccountPilotFeatures", "GetCustomerPilotFeatures", "GetCurrentUser"]);
// UET tags belong to the manager account and are shared by every ad account under it.
const UET = "Microsoft UET tags belong to the manager account (customer) and are shared by every ad account under it; outside the one configured ad account the kit works in";
// Gets that hand back a credential or a file link are treated as writes, so they need the write gate and approval.
const SENSITIVE_GET = /(AuthKey|UploadUrl|FileUrl)$/;
const ADMIN = "Microsoft account administration (users, sign-up, client links, other customers) is outside the one configured ad account the kit works in";

export const MSADS_SOURCES = [
 { url: "https://github.com/BingAds/BingAds-Python-SDK/tree/main/openapi_client", official: "vendor GitHub: BingAds" },
 { url: "https://learn.microsoft.com/en-us/advertising/campaign-management-service/getcampaignsbyaccountid?view=bingads-13", official: "vendor-domain: learn.microsoft.com" },
 { url: "https://learn.microsoft.com/en-us/advertising/customer-management-service/getaccount?view=bingads-13", official: "vendor-domain: learn.microsoft.com" },
 { url: "https://learn.microsoft.com/en-us/advertising/reporting-service/submitgeneratereport?view=bingads-13", official: "vendor-domain: learn.microsoft.com" },
];

export function mapMicrosoftRest(ops) {
 for (const op of ops) {
  const [api, name] = op.id.split(".");
  const route = mapping[op.id];
  if (!route || !HOSTS[api]) { op.authUnsupported = "no Microsoft REST route is mapped for this operation"; continue; }
  if (api === "customer-management" && !CUSTOMER_READS.has(name)) { op.authUnsupported = ADMIN; continue; }
  if (name.includes("UetTag")) { op.authUnsupported = UET; continue; }
  // Gets change nothing; a report request only queues a report file for the configured account.
  const read = (name.startsWith("Get") && !SENSITIVE_GET.test(name)) || api === "reporting";
  Object.assign(op, route, { server: HOSTS[api], msadsRest: true, summary: `Microsoft Advertising ${name}`,
   doc_url: `https://learn.microsoft.com/en-us/advertising/${api}-service/${name.toLowerCase()}?view=bingads-13`, kind: read ? "read" : "write" });
  // Microsoft Learn marks AccountId required for both calls and Campaigns required for AddCampaigns.
  if (["GetCampaignsByAccountId", "AddCampaigns"].includes(name))
   op.params = op.params.map(p => ({...p, required: p.name === "AccountId" || (name === "AddCampaigns" && p.name === "Campaigns")}));
  delete op.authUnsupported;
  if (read) { op.readPost = true; op.override = `read-only Microsoft ${name}`; }
 }
}
