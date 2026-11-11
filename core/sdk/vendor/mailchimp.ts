import { vendorRequire } from "./load.ts";
import { PLACEHOLDER_KEY } from "./gate.ts";
import { gateSuperagent } from "./superagent.ts";
export function mailchimp() {
  const server = process.env.MAILCHIMP_DC ?? "";
  if (!/^us[0-9]+$/.test(server)) throw new Error("Mailchimp server must be its assigned us-number");
  const req = vendorRequire("mailchimp");
  gateSuperagent("mailchimp", req, "@mailchimp/mailchimp_marketing");
  const client = req("@mailchimp/mailchimp_marketing");
  client.setConfig({ accessToken: PLACEHOLDER_KEY, server });
  return client;
}
