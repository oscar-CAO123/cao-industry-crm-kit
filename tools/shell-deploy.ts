// Render the CRM shell's deploy files for wherever the business runs it. Every target runs the same image and the same
// commands; only the scheduler and the place the one 1Password token is kept change.
//   node tools/shell-deploy.ts <target> <out-dir> <industry> [industry ...]
// Targets: docker, server, railway, aws, gcp, azure, vercel, supabase, cloudflare, netlify.
// - Web app:   sh shell/scripts/with-secrets.sh -- node shell/server.js
// - Each cron: sh shell/scripts/with-secrets.sh -- node shell/workflows/run.ts run <workflow-dir> <entry>
// - Schema:    sh shell/scripts/with-secrets.sh -- node shell/scripts/db-apply.mjs
// Container targets (docker, server, railway, aws, gcp, azure) run the cron command on a schedule. URL-only schedulers
// (vercel, supabase, cloudflare, netlify) call the shell's trigger route /api/workflows/run with a bearer token.
// No secret value is ever written by this tool: it writes key NAMES and op:// placeholders only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = ["docker", "server", "railway", "aws", "gcp", "azure", "vercel", "supabase", "cloudflare", "netlify"] as const;
export type Target = (typeof TARGETS)[number];
const CRON5 = /^[0-9*\/,-]+( [0-9*\/,-]+){4}$/; // five fields of digits, * / , - only: it is pasted into shell and SQL
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const WEB = "sh shell/scripts/with-secrets.sh -- node shell/server.js";
const BASE_KEYS = ["DATABASE_URL", "DIRECT_URL", "BETTER_AUTH_SECRET", "GOOGLE_ID", "GOOGLE_SECRET", "SMTP_URL", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY", "KIT_RUNNER_TOKEN"];

export interface Job { workflow: string; dir: string; entry: string; schedule: string; slug: string }

/** Every cron of every workflow the given industry templates switch on, once each. */
export function jobs(industries: string[]): Job[] {
  const out = new Map<string, Job>();
  for (const ind of industries) {
    if (!SLUG.test(ind)) throw new Error(`bad industry ${ind}`);
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "industries", ind, "crm-shell", "template.json"), "utf8"));
    for (const w of t.workflows as { id: string; dir: string }[]) {
      if (!/^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/.test(w.dir)) throw new Error(`bad workflow dir ${w.dir}`);
      const rec = JSON.parse(fs.readFileSync(path.join(ROOT, w.dir, "workflow.json"), "utf8"));
      for (const c of rec.crons ?? []) {
        if (!CRON5.test(c.schedule) || !/^[A-Za-z0-9-]{1,40}$/.test(c.entry)) throw new Error(`bad cron in ${w.dir}`); // letters, digits, dashes: safe in a command line
        const slug = `${String(rec.id).replace(/[^a-z0-9]+/gi, "-")}-${c.entry}`.toLowerCase().slice(0, 60); // cloud job names are lowercase
        out.set(slug, { workflow: String(rec.id), dir: w.dir, entry: c.entry, schedule: c.schedule, slug });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Key names the switched-on workflows need, from each platform's own record. Names only. */
export function keyNames(industries: string[]): string[] {
  const keys = new Set(BASE_KEYS);
  for (const ind of industries) {
    const t = JSON.parse(fs.readFileSync(path.join(ROOT, "industries", ind, "crm-shell", "template.json"), "utf8"));
    for (const w of t.workflows as { dir: string }[]) {
      const rec = JSON.parse(fs.readFileSync(path.join(ROOT, w.dir, "workflow.json"), "utf8"));
      for (const p of new Set([...Object.keys(rec.draft_ops ?? {}), ...Object.keys(rec.live_ops ?? {})])) {
        if (!SLUG.test(p)) continue;
        const f = path.join(ROOT, "core/sdk/platforms", p, "platform.json");
        if (fs.existsSync(f)) for (const k of JSON.parse(fs.readFileSync(f, "utf8")).keys ?? []) keys.add(String(k));
      }
    }
  }
  return [...keys].filter((k) => /^[A-Z][A-Z0-9_]{1,63}$/.test(k)).sort();
}

export function awsCron(s: string): string {
  if (!CRON5.test(s)) throw new Error(`bad cron ${s}`);
  let [mi, h, dom, mon, dow] = s.split(" ");
  const step = (x: string) => x.replace(/^\*\//, "0/");
  if (dow === "*") dow = "?"; else dom = "?";
  return `cron(${step(mi)} ${step(h)} ${dom} ${mon} ${dow} *)`;
}

const oneLine = () => note.replace(/^# /gm, "").replace(/\n/g, " ").trim();
const cronCmd = (j: Job) => `sh shell/scripts/with-secrets.sh -- node shell/workflows/run.ts run ${j.dir} ${j.entry}`;
const note = "# Every process starts through shell/scripts/with-secrets.sh: the host holds ONLY OP_SERVICE_ACCOUNT_TOKEN (plus SHELL_VAULT,\n# the vault name). All times UTC. Crons read and draft; every send, payment or live change waits for the approval click.\n";

export function render(target: Target, js: Job[], keys: string[]): Record<string, string> {
  const refs = JSON.stringify(Object.fromEntries(keys.map((k) => [k, `op://YOUR_VAULT/${k.toLowerCase().replace(/_/g, "-")}/credential`])), null, 2) + "\n";
  const common = { "secrets.refs.json.example": refs };
  const env = "SHELL_VAULT=<vault name>\nKIT_ALLOW_WRITES=1\nNEXT_PUBLIC_APP_NAME=<business name>\nBETTER_AUTH_URL=https://<crm host>\nAUTH_SIGNUP_DOMAINS=<business email domain>\n";
  const trigger = (j: Job) => ({ workflow: j.workflow, cron: j.entry });
  switch (target) {
    case "docker":
      return { ...common, "config.env.example": env,
        "run-web.sh": `#!/bin/sh\n${note}exec docker run -d --name crm-shell --restart unless-stopped -p 3000:3000 --env-file config.env -e OP_SERVICE_ACCOUNT_TOKEN crm-shell\n`,
        "crontab": note + js.map((j) => `${j.schedule} docker run --rm --env-file /opt/crm-shell/config.env -e OP_SERVICE_ACCOUNT_TOKEN crm-shell node shell/workflows/run.ts run ${j.dir} ${j.entry} >> /var/log/crm-shell-${j.slug}.log 2>&1`).join("\n") + "\n" };
    case "server":
      return { ...common, "config.env.example": env,
        "crm-shell.service": `[Unit]\nDescription=CRM shell\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=/opt/crm-shell\n# /etc/crm-shell/op-token.env holds ONLY OP_SERVICE_ACCOUNT_TOKEN=..., owned by root, chmod 600.\nEnvironmentFile=/etc/crm-shell/op-token.env\nEnvironmentFile=/opt/crm-shell/config.env\nExecStart=/usr/bin/${WEB}\nUser=crm-shell\nRestart=always\nNoNewPrivileges=true\nProtectSystem=strict\nPrivateTmp=true\n\n[Install]\nWantedBy=multi-user.target\n`,
        "crontab": note + "# root's crontab. config.env is read as shell, so it must be owned by root and not writable by crm-shell (chown root:root, chmod 644). The job itself runs as crm-shell.\n" + js.map((j) => `${j.schedule} cd /opt/crm-shell && set -a && . /etc/crm-shell/op-token.env && . ./config.env && runuser -u crm-shell -- ${cronCmd(j)} >> /var/log/crm-shell-${j.slug}.log 2>&1`).join("\n") + "\n" };
    case "railway":
      return { ...common, "README.txt": `${note}Set OP_SERVICE_ACCOUNT_TOKEN as a sealed variable on every service; nothing else secret goes in Railway.\n`,
        "web/railway.json": JSON.stringify({ build: { builder: "DOCKERFILE", dockerfilePath: "shell/Dockerfile" }, deploy: { startCommand: WEB, healthcheckPath: "/sign-in", restartPolicyType: "ALWAYS" } }, null, 2) + "\n",
        ...Object.fromEntries(js.map((j) => [`${j.slug}/railway.json`, JSON.stringify({ build: { builder: "DOCKERFILE", dockerfilePath: "shell/Dockerfile" }, deploy: { startCommand: cronCmd(j), cronSchedule: j.schedule, restartPolicyType: "NEVER" } }, null, 2) + "\n"])) };
    case "aws": {
      const sched = js.map((j) => `  Cron${j.slug.replace(/[^a-zA-Z0-9]/g, "")}:\n    Type: AWS::Scheduler::Schedule\n    Properties:\n      ScheduleExpression: "${awsCron(j.schedule)}"\n      FlexibleTimeWindow: { Mode: "OFF" }\n      Target:\n        Arn: !Ref ClusterArn\n        RoleArn: !Ref SchedulerRoleArn\n        EcsParameters:\n          TaskDefinitionArn: !Ref Task\n          LaunchType: FARGATE\n          NetworkConfiguration: { AwsvpcConfiguration: { Subnets: !Ref Subnets, SecurityGroups: [!Ref SecurityGroup] } }\n        Input: '{"containerOverrides":[{"name":"crm-shell","command":["node","shell/workflows/run.ts","run","${j.dir}","${j.entry}"]}]}'\n`).join("");
      return { ...common, "cloudformation.yaml": `# ${oneLine()}\n# The token lives in AWS Secrets Manager (OpTokenSecretArn) and reaches the container as a secret, never as plain text.\nAWSTemplateFormatVersion: "2010-09-09"\nParameters:\n  ImageUri: { Type: String }\n  ClusterArn: { Type: String }\n  Subnets: { Type: "List<AWS::EC2::Subnet::Id>" }\n  SecurityGroup: { Type: String }\n  ExecutionRoleArn: { Type: String }\n  SchedulerRoleArn: { Type: String }\n  OpTokenSecretArn: { Type: String }\n  Vault: { Type: String }\nResources:\n  Task:\n    Type: AWS::ECS::TaskDefinition\n    Properties:\n      RequiresCompatibilities: [FARGATE]\n      NetworkMode: awsvpc\n      Cpu: "512"\n      Memory: "1024"\n      ExecutionRoleArn: !Ref ExecutionRoleArn\n      ContainerDefinitions:\n        - Name: crm-shell\n          Image: !Ref ImageUri\n          PortMappings: [{ ContainerPort: 3000 }]\n          Environment: [{ Name: SHELL_VAULT, Value: !Ref Vault }, { Name: KIT_ALLOW_WRITES, Value: "1" }]\n          Secrets: [{ Name: OP_SERVICE_ACCOUNT_TOKEN, ValueFrom: !Ref OpTokenSecretArn }]\n  Web:\n    Type: AWS::ECS::Service\n    Properties:\n      Cluster: !Ref ClusterArn\n      LaunchType: FARGATE\n      DesiredCount: 1\n      TaskDefinition: !Ref Task\n      NetworkConfiguration: { AwsvpcConfiguration: { Subnets: !Ref Subnets, SecurityGroups: [!Ref SecurityGroup] } }\n${sched}` };
    }
    case "gcp":
      return { ...common, "deploy.sh": `#!/bin/sh\n${note}# The token lives in Secret Manager as "crm-op-token".\nset -e\nIMAGE="$1"; REGION="\${REGION:-australia-southeast1}"; VAULT="$2"\ngcloud run deploy crm-shell --image "$IMAGE" --region "$REGION" --set-secrets OP_SERVICE_ACCOUNT_TOKEN=crm-op-token:latest --set-env-vars SHELL_VAULT="$VAULT",KIT_ALLOW_WRITES=1\n` +
        js.map((j) => `gcloud run jobs deploy crm-${j.slug} --image "$IMAGE" --region "$REGION" --set-secrets OP_SERVICE_ACCOUNT_TOKEN=crm-op-token:latest --set-env-vars SHELL_VAULT="$VAULT",KIT_ALLOW_WRITES=1 --command sh --args shell/scripts/with-secrets.sh,--,node,shell/workflows/run.ts,run,${j.dir},${j.entry}\ngcloud scheduler jobs create http crm-${j.slug} --location "$REGION" --schedule "${j.schedule}" --time-zone UTC --http-method POST --uri "https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$(gcloud config get-value project)/jobs/crm-${j.slug}:run" --oauth-service-account-email "\${SCHEDULER_SA}"`).join("\n") + "\n" };
    case "azure":
      return { ...common, "deploy.sh": `#!/bin/sh\n${note}# The token lives in Key Vault as "crm-op-token"; the apps read it through a managed identity reference.\nset -e\nRG="$1"; ENV="$2"; IMAGE="$3"; VAULT="$4"; KV_URI="$5"\nSECRET="op-token=keyvaultref:$KV_URI/secrets/crm-op-token,identityref:system"\naz containerapp create -g "$RG" -n crm-shell --environment "$ENV" --image "$IMAGE" --ingress external --target-port 3000 --system-assigned --secrets "$SECRET" --env-vars OP_SERVICE_ACCOUNT_TOKEN=secretref:op-token SHELL_VAULT="$VAULT" KIT_ALLOW_WRITES=1\n` +
        js.map((j) => `az containerapp job create -g "$RG" -n crm-${j.slug.slice(0, 28)} --environment "$ENV" --image "$IMAGE" --trigger-type Schedule --cron-expression "${j.schedule}" --replica-timeout 1800 --system-assigned --secrets "$SECRET" --env-vars OP_SERVICE_ACCOUNT_TOKEN=secretref:op-token SHELL_VAULT="$VAULT" KIT_ALLOW_WRITES=1 --command sh --args "shell/scripts/with-secrets.sh" "--" "node" "shell/workflows/run.ts" "run" "${j.dir}" "${j.entry}"`).join("\n") + "\n" };
    case "vercel":
      return { ...common, "vercel.json": JSON.stringify({ crons: js.map((j) => ({ path: `/api/workflows/run?workflow=${encodeURIComponent(j.workflow)}&cron=${j.entry}`, schedule: j.schedule })) }, null, 2) + "\n",
        "README.txt": `${note}Vercel runs the Next app itself. Set OP_SERVICE_ACCOUNT_TOKEN as a sensitive environment variable and CRON_SECRET\nto the same value as KIT_RUNNER_TOKEN in 1Password. The start command must keep the launcher: build with "next build",\nand point the database at a Postgres the business owns.\n` };
    case "supabase":
      return { ...common, "pg_cron.sql": `-- ${oneLine()}\n-- The database is Supabase; the web app runs on one of the container targets. Store the runner token in Supabase Vault\n-- first:  select vault.create_secret('<token>', 'kit_runner_token');  It is read at call time, never kept in a job.\n` +
        js.map((j) => `select cron.schedule('crm-${j.slug}', '${j.schedule}', $$ select net.http_post(url := '<CRM URL>/api/workflows/run', headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kit_runner_token')), body := '${JSON.stringify(trigger(j))}'::jsonb) $$);`).join("\n") + "\n" };
    case "cloudflare":
      // One every-minute trigger (Cloudflare caps triggers per worker); the worker matches each job's own schedule.
      return { ...common,
        "wrangler.toml": `name = "crm-shell-crons"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\n# CRM_URL is a plain var; KIT_RUNNER_TOKEN is set with: wrangler secret put KIT_RUNNER_TOKEN\n[vars]\nCRM_URL = "https://<crm host>"\n[triggers]\ncrons = ["* * * * *"]\n`,
        "worker.js": `// ${oneLine()}\nconst JOBS = ${JSON.stringify(js.map((j) => ({ schedule: j.schedule, ...trigger(j) })))};\n` +
          `const part = (f, v, lo) => f.split(",").some((x) => { const [r, st] = x.split("/"); const step = Number(st || 1); const [a, b] = r === "*" ? [lo, 99] : r.split("-").map(Number); const hi = b ?? (st ? 99 : a); return v >= a && v <= hi && (v - a) % step === 0; });\n` +
          `export const due = (cron, d) => { const [mi, h, dom, mon, dow] = cron.split(" "); return part(mi, d.getUTCMinutes(), 0) && part(h, d.getUTCHours(), 0) && part(dom, d.getUTCDate(), 1) && part(mon, d.getUTCMonth() + 1, 1) && part(dow, d.getUTCDay(), 0); };\n` +
          `export default {\n  async scheduled(event, env, ctx) {\n    const now = new Date(event.scheduledTime);\n    for (const { schedule, ...job } of JOBS) if (due(schedule, now)) ctx.waitUntil(fetch(env.CRM_URL + "/api/workflows/run", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.KIT_RUNNER_TOKEN }, body: JSON.stringify(job) }));\n  },\n};\n` };
    case "netlify":
      return { ...common, ...Object.fromEntries(js.map((j) => [`netlify/functions/crm-${j.slug}.mjs`,
        `// ${j.workflow} ${j.entry}. KIT_RUNNER_TOKEN and CRM_URL are Netlify environment variables (the token marked secret).\nexport default async () => {\n  const r = await fetch(process.env.CRM_URL + "/api/workflows/run", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + process.env.KIT_RUNNER_TOKEN }, body: ${JSON.stringify(JSON.stringify(trigger(j)))} });\n  return new Response(null, { status: r.status });\n};\nexport const config = { schedule: "${j.schedule}" };\n`])) };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [target, out, ...industries] = process.argv.slice(2);
  if (!TARGETS.includes(target as Target) || !out || !industries.length) {
    console.error(`usage: node tools/shell-deploy.ts <${TARGETS.join("|")}> <out-dir> <industry> [industry ...]`); process.exit(1);
  }
  const js = jobs(industries), keys = keyNames(industries);
  for (const [f, body] of Object.entries(render(target as Target, js, keys))) {
    const p = path.join(out, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
  }
  console.log(`${target}: ${js.length} cron jobs, ${keys.length} key names (op:// placeholders only) written to ${out}`);
}
