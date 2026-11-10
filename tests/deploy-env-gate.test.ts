// The docker and server deploys refuse to start unless the key file is chmod 600, and the server launcher exports its keys.
import test from "node:test";
import assert from "node:assert/strict";
import { render } from "../tools/deploy.ts";

const DIR = "industries/all/workflows/compliance-safety/safety-forms";

test("docker run.sh refuses a key file that is not chmod 600", () => {
  const run = render(DIR, {}, "docker")["run.sh"];
  assert.match(run, /stat -c %a kit\.env/);
  assert.match(run, /\[ "\$M" = "600" \] \|\| \{ echo "kit\.env must be chmod 600/);
  assert.ok(run.indexOf('"$M" = "600"') < run.indexOf("exec docker run"), "the check runs before docker starts");
});

test("server deploy runs every cron through a guarded launcher that exports the keys", () => {
  const files = render(DIR, {}, "server");
  const run = files["run.sh"];
  assert.match(run, /\[ "\$M" = "600" \] \|\| \{ echo "\$F must be chmod 600/);
  assert.match(run, /set -a; \. "\$F"; set \+a/);
  assert.ok(run.indexOf('"$M" = "600"') < run.indexOf('. "$F"'), "the check runs before the keys are read");
  assert.ok(!/\. \/etc\/kit\/env/.test(files["crontab"]), "the crontab no longer sources the key file itself");
  assert.match(files["crontab"], /\/opt\/kit\/run\.sh \S+ >>/);
});
