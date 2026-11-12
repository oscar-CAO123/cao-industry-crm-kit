// The 1Password token reaches the shell as a mounted file on every deploy target whose platform offers one, so it never
// sits in the container's environment. Only Railway, Vercel, AWS ECS and Azure scheduled jobs (no file option) use a variable.
import test from "node:test";
import assert from "node:assert/strict";
import { jobs, keyNames, render } from "../tools/shell-deploy.ts";

const js = jobs(["construction"]);
const keys = keyNames(["construction"]);

test("server: systemd hands the token over as a credential file, and crons point at the same file", () => {
  const files = render("server", js, keys);
  assert.match(files["crm-shell.service"], /^LoadCredential=op-token:\/etc\/crm-shell\/op-token$/m);
  assert.doesNotMatch(files["crm-shell.service"] + files.crontab, /op-token\.env|OP_SERVICE_ACCOUNT_TOKEN=/);
  for (const line of files.crontab.split("\n").filter((l) => l.includes("runuser"))) assert.match(line, /SHELL_OP_TOKEN_FILE=\/etc\/crm-shell\/op-token runuser -u crm-shell -- /);
});

test("gcp: the service and every job mount the secret as a file", () => {
  const sh = render("gcp", js, keys)["deploy.sh"];
  assert.doesNotMatch(sh, /OP_SERVICE_ACCOUNT_TOKEN=/);
  assert.equal(sh.match(/--set-secrets \/run\/secrets\/shell_op_token=crm-op-token:latest/g)?.length, js.length + 1);
});

test("azure: the web app mounts the token through a user-assigned identity; jobs use that identity too", () => {
  const sh = render("azure", js, keys)["deploy.sh"];
  const web = sh.split("\n").find((l) => l.startsWith("az containerapp create"))!;
  assert.match(web, /--user-assigned "\$IDENTITY" .*--secret-volume-mount \/run\/secrets .*SHELL_OP_TOKEN_FILE=\/run\/secrets\/op-token/);
  assert.doesNotMatch(web, /OP_SERVICE_ACCOUNT_TOKEN/);
  assert.doesNotMatch(sh, /system-assigned|identityref:system/);
  for (const line of sh.split("\n").filter((l) => l.startsWith("az containerapp job create"))) assert.match(line, /--mi-user-assigned "\$IDENTITY"/);
});

test("docker never passes the token as a variable", () => {
  assert.doesNotMatch(Object.values(render("docker", js, keys)).join("\n"), /OP_SERVICE_ACCOUNT_TOKEN=/);
});
