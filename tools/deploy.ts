// Render a workflow's crons for wherever the client deploys. Every target runs the same command:
//   node tools/workflow.ts run <workflow-dir> <cron>
// with settings in KIT_SETTINGS, state in KIT_STATE_DIR on a persistent volume, and the client's keys as environment
// variables from the provider's own secret store. No secret value is ever written by this tool.
// Container targets run the command on a schedule: docker, server, railway, aws (ECS + EventBridge Scheduler),
// gcp (Cloud Run Jobs + Cloud Scheduler), azure (Container Apps Jobs). Trigger-only targets (vercel, supabase,
// cloudflare) call the HTTP runner (tools/workflow-http.ts), which runs where the state lives.
//   node tools/deploy.ts <workflow-dir> <settings.json> <target> <out-dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TARGETS = ["docker", "server", "railway", "aws", "gcp", "azure", "vercel", "supabase", "cloudflare"] as const;
type Cron = { name: string; schedule: string; entry: string };
const CRON5 = /^(\S+) (\S+) (\S+) (\S+) (\S+)$/;
const NAME = /^[a-z0-9-]{1,40}$/;

/** EventBridge needs six fields and exactly one of day-of-month or day-of-week as "?". */
export function awsCron(s: string): string {
  const m = CRON5.exec(s); if (!m) throw new Error(`bad cron ${s}`);
  let [, mi, h, dom, mon, dow] = m;
  const step = (x: string) => x.replace(/^\*\//, "0/");
  if (dow === "*") dow = "?"; else dom = "?";
  return `cron(${step(mi)} ${step(h)} ${dom} ${mon} ${dow} *)`;
}

/** Key names for every app this deploy uses: the apps the settings name (as a value, or as a section such as
 *  `sitebook: {...}` or `microsoft_365: {...}`) that are also in the workflow's own draft or live operations. */
export function secretNames(settings: any, wf?: { draft_ops?: Record<string, string[]>; live_ops?: Record<string, string[]> }): string[] {
  const ops = new Set<string>([...Object.keys(wf?.draft_ops ?? {}), ...Object.keys(wf?.live_ops ?? {})]);
  const named = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string") named.add(v.toLowerCase().replace(/_/g, "-")); };
  for (const [k, v] of Object.entries(settings ?? {})) {
    add(k);
    if (Array.isArray(v)) v.forEach(add); else add(v);
  }
  const used = new Set<string>([...(settings.intake ?? []), settings.quotes, settings.rate_card, settings.messages].filter(Boolean));
  for (const p of named) if (ops.has(p) && fs.existsSync(path.join(ROOT, "core/sdk/platforms", p, "platform.json"))) used.add(p);
  const keys = new Set<string>();
  for (const p of used) {
    if (!/^[a-z0-9-]+$/.test(p)) throw new Error(`bad platform ${p}`);
    for (const k of JSON.parse(fs.readFileSync(path.join(ROOT, "core/sdk/platforms", p, "platform.json"), "utf8")).keys ?? []) keys.add(k);
  }
  return [...keys].sort();
}

export function render(dir: string, settings: any, target: (typeof TARGETS)[number]): Record<string, string> {
  if (!/^industries\/[a-z-]+\/workflows\/[a-z-]+\/[a-z0-9-]+$/.test(dir)) throw new Error(`not a workflow folder: ${dir}`);
  const wf = JSON.parse(fs.readFileSync(path.join(ROOT, dir, "workflow.json"), "utf8"));
  const crons: Cron[] = wf.crons;
  for (const c of crons) if (!NAME.test(c.name) || !NAME.test(c.entry) || !CRON5.test(c.schedule)) throw new Error(`bad cron ${c.name}`);
  const keys = secretNames(settings, wf);
  const slug = String(wf.id).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const cmd = (c: Cron) => `node tools/workflow.ts run ${dir} ${c.entry}`;
  const env = ["KIT_SETTINGS=/config/settings.json", "KIT_STATE_DIR=/state", "KIT_ALLOW_WRITES=1"];
  const note = `# ${wf.name} (${wf.id}): crons read and draft; every send waits for approval in the CRM shell.\n# Keys from the provider's secret store: ${keys.join(", ")}.\n`;
  switch (target) {
    case "docker":
      return {
        "Dockerfile": `FROM node:22-slim\nWORKDIR /kit\nCOPY . .\nENV KIT_STATE_DIR=/state KIT_SETTINGS=/config/settings.json\nVOLUME ["/state"]\nUSER node\nENTRYPOINT ["node", "tools/workflow.ts"]\n`,
        "run.sh": `#!/bin/sh\n${note}# usage: ./run.sh <cron>   (mount settings at /config and keep /state on a volume)\nset -eu\nM=$(stat -c %a kit.env 2>/dev/null || stat -f %Lp kit.env)\n[ "$M" = "600" ] || { echo "kit.env must be chmod 600 (it is $M): keys never sit in a readable file" >&2; exit 1; }\nexec docker run --rm --env-file kit.env -e KIT_ALLOW_WRITES=1 -v kit-state:/state -v "$PWD/config:/config:ro" ${slug} run ${dir} "$1"\n`,
        "kit.env.example": keys.map((k) => `${k}=`).join("\n") + "\n",
        "crontab": note + "# On the Docker host, all times UTC, from the folder holding run.sh, kit.env and config/.\n" + crons.map((c) => `${c.schedule} cd /opt/kit-deploy && ./run.sh ${c.entry} >> /var/log/kit-${c.name}.log 2>&1`).join("\n") + "\n",
      };
    case "server":
      return {
        "run.sh": `#!/bin/sh\n${note}# usage: /opt/kit/run.sh <cron>. Keys live in /etc/kit/env, which must be chmod 600.\nset -eu\nF=/etc/kit/env\nM=$(stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F")\n[ "$M" = "600" ] || { echo "$F must be chmod 600 (it is $M): keys never sit in a readable file" >&2; exit 1; }\nset -a; . "$F"; set +a\ncd /opt/kit\nexport KIT_SETTINGS=/etc/kit/settings.json KIT_STATE_DIR=/var/lib/kit KIT_ALLOW_WRITES=1\nexec node tools/workflow.ts run ${dir} "$1"\n`,
        "crontab": note + "# All times UTC. Keys live in /etc/kit/env (chmod 600); run.sh refuses to start if it is any more open.\n" + crons.map((c) =>
          `${c.schedule} /opt/kit/run.sh ${c.entry} >> /var/log/kit-${c.name}.log 2>&1`).join("\n") + "\n",
      };
    case "railway":
      return Object.fromEntries(crons.map((c) => [`${c.name}/railway.json`, JSON.stringify({
        $schema: "https://railway.com/railway.schema.json", build: { builder: "DOCKERFILE" },
        deploy: { startCommand: cmd(c), cronSchedule: c.schedule, restartPolicyType: "NEVER" } }, null, 1) + "\n"])
        .concat([["README.md", `${note}\nOne Railway service per cron, each with the railway.json in its folder. Attach one volume at /state to all of them, add the keys above as service variables, plus ${env.join(", ")}.\n`]]));
    case "aws": {
      const sched = crons.map((c) => `  Schedule${c.name.replace(/-/g, "")}:\n    Type: AWS::Scheduler::Schedule\n    Properties:\n      Name: ${slug}-${c.name}\n      ScheduleExpression: "${awsCron(c.schedule)}"\n      ScheduleExpressionTimezone: UTC\n      FlexibleTimeWindow: { Mode: "OFF" }\n      Target:\n        Arn: !GetAtt Cluster.Arn\n        RoleArn: !GetAtt SchedulerRole.Arn\n        EcsParameters:\n          TaskDefinitionArn: !Ref Task\n          LaunchType: FARGATE\n          NetworkConfiguration: { AwsvpcConfiguration: { Subnets: !Ref Subnets, SecurityGroups: [!Ref SecurityGroup], AssignPublicIp: ENABLED } }\n        Input: '{"containerOverrides":[{"name":"kit","command":["run","${dir}","${c.entry}"]}]}'`).join("\n");
      const secrets = keys.map((k) => `            - { Name: ${k}, ValueFrom: !Sub "arn:aws:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:${slug}/${k}" }`).join("\n");
      return { "cloudformation.yaml": `${note}AWSTemplateFormatVersion: "2010-09-09"\nParameters:\n  Image: { Type: String }\n  Subnets: { Type: "List<AWS::EC2::Subnet::Id>" }\n  SecurityGroup: { Type: "AWS::EC2::SecurityGroup::Id" }\n  StateFileSystem: { Type: String, Description: "EFS file system for /state" }\n  SettingsParameter: { Type: String, Description: "SSM parameter holding settings.json" }\nResources:\n  Cluster: { Type: AWS::ECS::Cluster }\n  ExecRole:\n    Type: AWS::IAM::Role\n    Properties:\n      AssumeRolePolicyDocument: { Statement: [{ Effect: Allow, Principal: { Service: ecs-tasks.amazonaws.com }, Action: sts:AssumeRole }] }\n      ManagedPolicyArns: [arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy]\n      Policies: [{ PolicyName: secrets, PolicyDocument: { Statement: [{ Effect: Allow, Action: [secretsmanager:GetSecretValue, ssm:GetParameters], Resource: "*" }] } }]\n  SchedulerRole:\n    Type: AWS::IAM::Role\n    Properties:\n      AssumeRolePolicyDocument: { Statement: [{ Effect: Allow, Principal: { Service: scheduler.amazonaws.com }, Action: sts:AssumeRole }] }\n      Policies: [{ PolicyName: run, PolicyDocument: { Statement: [{ Effect: Allow, Action: [ecs:RunTask, iam:PassRole], Resource: "*" }] } }]\n  Task:\n    Type: AWS::ECS::TaskDefinition\n    Properties:\n      RequiresCompatibilities: [FARGATE]\n      NetworkMode: awsvpc\n      Cpu: "256"\n      Memory: "512"\n      ExecutionRoleArn: !GetAtt ExecRole.Arn\n      Volumes: [{ Name: state, EFSVolumeConfiguration: { FilesystemId: !Ref StateFileSystem, TransitEncryption: ENABLED } }]\n      ContainerDefinitions:\n        - Name: kit\n          Image: !Ref Image\n          MountPoints: [{ SourceVolume: state, ContainerPath: /state }]\n          Environment: [{ Name: KIT_STATE_DIR, Value: /state }, { Name: KIT_ALLOW_WRITES, Value: "1" }]\n          Secrets:\n            - { Name: KIT_SETTINGS_JSON, ValueFrom: !Ref SettingsParameter }\n${secrets}\n${sched}\n` };
    }
    case "gcp":
      return { "deploy.sh": `#!/bin/sh\n${note}# Needs: PROJECT, REGION, IMAGE, BUCKET (state), SA (service account), and each key in Secret Manager under the same name.\nset -eu\n` + crons.map((c) =>
        `gcloud run jobs deploy ${slug}-${c.name} --project "$PROJECT" --region "$REGION" --image "$IMAGE" --args=run,${dir},${c.entry} \\\n  --set-env-vars=KIT_STATE_DIR=/state,KIT_ALLOW_WRITES=1 --set-secrets=${["KIT_SETTINGS_JSON", ...keys].map((k) => `${k}=${k}:latest`).join(",")} \\\n  --add-volume=name=state,type=cloud-storage,bucket="$BUCKET" --add-volume-mount=volume=state,mount-path=/state --max-retries=0 --service-account "$SA"\n` +
        `gcloud scheduler jobs create http ${slug}-${c.name} --project "$PROJECT" --location "$REGION" --schedule "${c.schedule}" --time-zone UTC --http-method POST \\\n  --uri "https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/${slug}-${c.name}:run" --oauth-service-account-email "$SA"\n`).join("") };
    case "azure":
      return { "deploy.sh": `#!/bin/sh\n${note}# Needs: RG, ENVIRONMENT (Container Apps environment with an Azure Files storage named kitstate), IMAGE, KV (Key Vault URI) and\n# IDENTITY (a user-assigned identity that can read it). Each key is a Key Vault secret named like the variable in lower case with dashes.\n# No key value appears here. After creating each job, mount the kitstate storage at /state (az containerapp job update --yaml).\nset -eu\n` + crons.map((c) => {
        const names = ["KIT_SETTINGS_JSON", ...keys].map((k) => [k, k.toLowerCase().replace(/_/g, "-")]);
        return `az containerapp job create -n ${slug}-${c.name} -g "$RG" --environment "$ENVIRONMENT" --trigger-type Schedule --cron-expression "${c.schedule}" --replica-timeout 900 --replica-retry-limit 0 \\\n  --image "$IMAGE" --args run ${dir} ${c.entry} --mi-user-assigned "$IDENTITY" \\\n  --secrets ${names.map(([, n]) => `${n}=keyvaultref:"$KV"/secrets/${n},identityref:"$IDENTITY"`).join(" ")} \\\n  --env-vars KIT_STATE_DIR=/state KIT_ALLOW_WRITES=1 ${names.map(([k, n]) => `${k}=secretref:${n}`).join(" ")}\n`; }).join("") };
    case "vercel":
      return {
        "vercel.json": JSON.stringify({ crons: crons.map((c) => ({ path: `/api/kit-cron?c=${c.name}`, schedule: c.schedule })) }, null, 1) + "\n",
        "api/kit-cron.ts": `// Vercel Cron calls this; it forwards to the HTTP runner, which holds the workflow state. Set CRON_SECRET, KIT_RUNNER_URL, KIT_RUNNER_TOKEN.\nconst NAMES = new Set(${JSON.stringify(crons.map((c) => c.name))});\nexport async function GET(req: Request) {\n  if (req.headers.get("authorization") !== \`Bearer \${process.env.CRON_SECRET}\`) return new Response(null, { status: 401 });\n  const c = new URL(req.url).searchParams.get("c") ?? "";\n  if (!NAMES.has(c)) return new Response(null, { status: 404 });\n  const r = await fetch(\`\${process.env.KIT_RUNNER_URL}/run/\${c}\`, { method: "POST", headers: { authorization: \`Bearer \${process.env.KIT_RUNNER_TOKEN}\` } });\n  return new Response(null, { status: r.status });\n}\n`,
      };
    case "supabase":
      return { "cron.sql": `-- ${wf.name}: pg_cron calls the HTTP runner. Store the runner token in Vault as kit_runner_token and the runner URL as kit_runner_url.\n` + crons.map((c) =>
        `select cron.schedule('${slug}-${c.name}', '${c.schedule}', $$select net.http_post(url := (select decrypted_secret from vault.decrypted_secrets where name = 'kit_runner_url') || '/run/${c.name}', headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kit_runner_token')))$$);`).join("\n") + "\n" };
    case "cloudflare":
      return {
        "wrangler.toml": `name = "${slug}-cron"\nmain = "src/index.ts"\ncompatibility_date = "2024-11-01"\n[triggers]\ncrons = ${JSON.stringify(crons.map((c) => c.schedule))}\n# Secrets: wrangler secret put KIT_RUNNER_URL / KIT_RUNNER_TOKEN\n`,
        "src/index.ts": `// Cloudflare Cron Triggers call the HTTP runner, which holds the workflow state.\nconst BY = ${JSON.stringify(Object.fromEntries(crons.map((c) => [c.schedule, c.name])))} as Record<string, string>;\nexport default {\n  async scheduled(e: { cron: string }, env: { KIT_RUNNER_URL: string; KIT_RUNNER_TOKEN: string }) {\n    const c = BY[e.cron]; if (!c) return;\n    await fetch(\`\${env.KIT_RUNNER_URL}/run/\${c}\`, { method: "POST", headers: { authorization: \`Bearer \${env.KIT_RUNNER_TOKEN}\` } });\n  },\n};\n`,
      };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, settingsPath, target, out] = process.argv.slice(2);
  if (!TARGETS.includes(target as any) || !out) { console.error(`usage: deploy.ts <workflow-dir> <settings.json> <${TARGETS.join("|")}> <out-dir>`); process.exit(1); }
  const files = render(dir, JSON.parse(fs.readFileSync(settingsPath, "utf8")), target as any);
  for (const [f, body] of Object.entries(files)) {
    const p = path.join(out, f); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
  }
  console.log(Object.keys(files).map((f) => path.join(out, f)).join("\n"));
}
