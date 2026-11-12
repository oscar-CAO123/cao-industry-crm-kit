import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { render } from "../tools/shell-deploy.ts";

test("Docker web binds locally until a TLS proxy exposes it", () => {
  const web = render("docker", [], [])["run-web.sh"];
  assert.match(web, /-p 127\.0\.0\.1:3000:3000\b/);
});

test("Compose waits for Postgres health and successful migration", () => {
  const compose = fs.readFileSync(new URL("../shell/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /pg_isready -U shell -d shell/);
  assert.match(compose, /db: \{ condition: service_healthy \}/);
  assert.match(compose, /migrate: \{ condition: service_completed_successfully \}/);
});
