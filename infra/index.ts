// Single-file Pulumi stack for automated-agents.
//
// Provisions:
//   - One t3.small Ubuntu 24.04 EC2 in the default VPC
//   - Security Group: 22/80/443 inbound, all outbound
//   - IAM role with SSM core policy (keyless SSH via Session Manager)
//   - Elastic IP attached to the instance
//   - User-data cloud-init that installs Node 20 + Caddy + git, clones
//     the public automated-agents repo, builds it, writes secrets to
//     /etc/automated-agents.env, wires a systemd unit, and configures
//     Caddy to reverse-proxy 443 → localhost:8080 with auto-LE.
//
// Secrets are set via `pulumi config set --secret`:
//   anthropicApiKey, githubWebhookSecret, githubToken
//
// They are embedded into the EC2 user-data. User-data is visible to
// anyone with ec2:DescribeInstanceAttribute on the instance; for a
// shared-account POC this is acceptable. Graduate to Secrets Manager
// or SSM Parameter Store before this holds anything real.

import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const stack = pulumi.getStack();
const baseName = 'automated-agents';
const cfg = new pulumi.Config();

const anthropicApiKey = cfg.requireSecret('anthropicApiKey');
const githubWebhookSecret = cfg.requireSecret('githubWebhookSecret');
const githubToken = cfg.requireSecret('githubToken');

// --- Default VPC + first default-for-az subnet --------------------------
const defaultVpc = aws.ec2.getVpcOutput({ default: true });
const defaultSubnets = aws.ec2.getSubnetsOutput({
  filters: [
    { name: 'vpc-id', values: [defaultVpc.id] },
    { name: 'default-for-az', values: ['true'] },
  ],
});
const subnetId = defaultSubnets.ids.apply((ids) => {
  if (!ids.length) {
    throw new Error(
      'no default-for-az subnets found in the default VPC; ' +
        'create at least one or target a non-default VPC',
    );
  }
  return ids[0];
});

// --- AMI: Ubuntu 24.04 LTS amd64 (Canonical) ----------------------------
const ami = aws.ec2.getAmiOutput({
  mostRecent: true,
  owners: ['099720109477'],
  filters: [
    {
      name: 'name',
      values: ['ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*'],
    },
    { name: 'state', values: ['available'] },
  ],
});

// --- Security group: SSH + HTTP + HTTPS ---------------------------------
const sg = new aws.ec2.SecurityGroup(`${baseName}-${stack}-sg`, {
  description: 'automated-agents: SSH (22) + HTTP (80) + HTTPS (443)',
  vpcId: defaultVpc.id,
  ingress: [
    { protocol: 'tcp', fromPort: 22, toPort: 22, cidrBlocks: ['0.0.0.0/0'] },
    { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
    { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
  ],
  egress: [
    { protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] },
  ],
  tags: { Name: `${baseName}-${stack}-sg`, Stack: stack },
});

// --- IAM role for SSM Session Manager (no SSH key needed) ---------------
const role = new aws.iam.Role(`${baseName}-${stack}-role`, {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
      },
    ],
  }),
  tags: { Name: `${baseName}-${stack}-role`, Stack: stack },
});

new aws.iam.RolePolicyAttachment(`${baseName}-${stack}-ssm-attach`, {
  role: role.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
});

// --- SQS FIFO queue + DLQ -----------------------------------------------
// FIFO so MessageDeduplicationId (= x-github-delivery) gives us a 5-min
// idempotency window covering GitHub's webhook retry behavior.
// Visibility timeout is the worker's grace window if it crashes mid-job;
// the worker also extends it via heartbeat for jobs that run longer.
const dlq = new aws.sqs.Queue(`${baseName}-${stack}-dlq`, {
  name: `${baseName}-${stack}-dlq.fifo`,
  fifoQueue: true,
  messageRetentionSeconds: 1209600, // 14 days
  tags: { Stack: stack },
});

const jobQueue = new aws.sqs.Queue(`${baseName}-${stack}-queue`, {
  name: `${baseName}-${stack}.fifo`,
  fifoQueue: true,
  contentBasedDeduplication: false, // MessageDeduplicationId is set explicitly
  visibilityTimeoutSeconds: 900,
  messageRetentionSeconds: 345600, // 4 days
  receiveWaitTimeSeconds: 20,
  redrivePolicy: dlq.arn.apply((arn) =>
    JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 2 }),
  ),
  tags: { Stack: stack },
});

new aws.iam.RolePolicy(`${baseName}-${stack}-sqs-policy`, {
  role: role.id,
  policy: jobQueue.arn.apply((arn) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'sqs:SendMessage',
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes',
          ],
          Resource: arn,
        },
      ],
    }),
  ),
});

const instanceProfile = new aws.iam.InstanceProfile(
  `${baseName}-${stack}-profile`,
  { role: role.name, tags: { Stack: stack } },
);

// --- Cloud-init user-data: install Node/Caddy, clone, build, run --------
const awsRegion = aws.config.requireRegion();
const userData = pulumi
  .all([anthropicApiKey, githubWebhookSecret, githubToken, jobQueue.url])
  .apply(
    ([ak, ws, gt, qUrl]) => `#!/bin/bash
set -euo pipefail
exec > /var/log/cloud-init-user.log 2>&1

echo "[bootstrap] apt update"
apt-get update -qq

echo "[bootstrap] base packages"
apt-get install -y -qq \\
  ca-certificates curl gnupg debian-keyring debian-archive-keyring \\
  apt-transport-https git build-essential universal-ctags

echo "[bootstrap] node 20"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y -qq nodejs

echo "[bootstrap] claude code CLI"
# @anthropic-ai/claude-agent-sdk spawns the 'claude' binary as a subprocess,
# so the CLI must be present globally in addition to the npm-installed SDK.
npm install -g @anthropic-ai/claude-code 2>&1 | tail -3

echo "[bootstrap] go + task (needed for coder's verify loop)"
# Go 1.22 to /usr/local/go, symlinked into /usr/bin for systemd PATH.
GO_VERSION=1.22.6
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) GO_ARCH=amd64 ;;
  aarch64|arm64) GO_ARCH=arm64 ;;
  *) echo "unsupported arch $ARCH"; exit 1 ;;
esac
curl -fsSL "https://go.dev/dl/go\${GO_VERSION}.linux-\${GO_ARCH}.tar.gz" | tar -xz -C /usr/local
ln -sfn /usr/local/go/bin/go /usr/bin/go
# task runner — installed via go install so it lives in /usr/local/go/bin.
GOBIN=/usr/local/go/bin /usr/local/go/bin/go install \
  github.com/go-task/task/v3/cmd/task@latest
ln -sfn /usr/local/go/bin/task /usr/bin/task

echo "[bootstrap] caddy"
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key \\
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \\
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

echo "[bootstrap] agent user"
# claude-code refuses to run with --dangerously-skip-permissions under root.
# Create a dedicated non-root service user.
id agent >/dev/null 2>&1 || useradd -r -m -d /home/agent -s /bin/bash agent

echo "[bootstrap] state dirs"
mkdir -p /var/work/automated-agents /var/lib/automated-agents
chown -R agent:agent /var/work/automated-agents /var/lib/automated-agents

echo "[bootstrap] clone automated-agents"
mkdir -p /opt/automated-agents
git clone https://github.com/baglessdev/automated-agents.git /opt/automated-agents
chown -R agent:agent /opt/automated-agents
cd /opt/automated-agents

echo "[bootstrap] npm install + build"
# Using 'npm install' (not 'npm ci') so bootstrap succeeds whether or not
# a lockfile is present. The repo ships a lockfile so it's still deterministic.
npm install --no-audit --no-fund
npm run build

echo "[bootstrap] env file"
umask 077
cat > /etc/automated-agents.env <<ENV
PORT=8080
ANTHROPIC_API_KEY=${ak}
GITHUB_WEBHOOK_SECRET=${ws}
GITHUB_TOKEN=${gt}
SQS_QUEUE_URL=${qUrl}
AWS_REGION=${awsRegion}
ENV
chown agent:agent /etc/automated-agents.env

echo "[bootstrap] systemd unit"
cat > /etc/systemd/system/automated-agents.service <<'UNIT'
[Unit]
Description=automated-agents webhook worker
After=network.target

[Service]
Type=simple
User=agent
Group=agent
ExecStart=/usr/bin/node /opt/automated-agents/dist/main.js
WorkingDirectory=/opt/automated-agents
EnvironmentFile=/etc/automated-agents.env
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now automated-agents

echo "[bootstrap] caddy config"
# IMDSv2 token-auth fetch. The default curl to 169.254.169.254 without a
# token returns empty on instances configured with httpTokens=required.
# An empty PUBLIC_IP would produce a '.nip.io' Caddyfile, which LE rejects
# with "subject does not qualify for certificate".
IMDS_TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC_IP=$(curl -sH "X-aws-ec2-metadata-token: $IMDS_TOKEN" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
if [[ -z "$PUBLIC_IP" ]]; then
  echo "ERROR: could not fetch public IP from IMDS" >&2
  exit 1
fi
HOSTNAME="\${PUBLIC_IP//./-}.nip.io"

cat > /etc/caddy/Caddyfile <<CADDY
{
    email admin@\${HOSTNAME}
}

\${HOSTNAME} {
    reverse_proxy localhost:8080
    encode gzip
}
CADDY

systemctl reload caddy

echo "[bootstrap] done. webhook URL: https://\${HOSTNAME}/webhook"
`,
  );

// --- EC2 instance -------------------------------------------------------
const instance = new aws.ec2.Instance(
  `${baseName}-${stack}`,
  {
    ami: ami.id,
    instanceType: 't3.small',
    subnetId,
    vpcSecurityGroupIds: [sg.id],
    iamInstanceProfile: instanceProfile.name,
    associatePublicIpAddress: true,
    userData,
    // Force instance replacement if user-data changes. Safer than silent
    // drift; at POC scale the few-minute re-provision is fine.
    userDataReplaceOnChange: true,
    rootBlockDevice: {
      volumeType: 'gp3',
      volumeSize: 20,
      encrypted: true,
    },
    tags: { Name: `${baseName}-${stack}`, Stack: stack },
  },
  { dependsOn: [role] },
);

// --- Elastic IP ---------------------------------------------------------
const eip = new aws.ec2.Eip(`${baseName}-${stack}-eip`, {
  domain: 'vpc',
  instance: instance.id,
  tags: { Name: `${baseName}-${stack}-eip`, Stack: stack },
});

// --- Outputs ------------------------------------------------------------
export const instanceId = instance.id;
export const publicIp = eip.publicIp;
export const hostname = eip.publicIp.apply(
  (ip) => `${ip.replace(/\./g, '-')}.nip.io`,
);
export const webhookUrl = hostname.apply((h) => `https://${h}/webhook`);
export const healthUrl = hostname.apply((h) => `https://${h}/health`);
export const queueUrl = jobQueue.url;
export const dlqUrl = dlq.url;
