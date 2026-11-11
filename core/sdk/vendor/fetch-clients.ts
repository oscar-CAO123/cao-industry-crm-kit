import { vendorRequire } from "./load.ts";
import { gatedFetch, PLACEHOLDER_KEY } from "./gate.ts";

export function slack() {
  const { WebClient } = vendorRequire("slack")("@slack/web-api");
  return new WebClient(PLACEHOLDER_KEY, { fetch: gatedFetch("slack"), retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, allowAbsoluteUrls: false, logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel() { return "error"; }, setName() {} } });
}
export function dropbox() {
  const { Dropbox } = vendorRequire("dropbox")("dropbox");
  return new Dropbox({ accessToken: PLACEHOLDER_KEY, fetch: gatedFetch("dropbox") });
}
