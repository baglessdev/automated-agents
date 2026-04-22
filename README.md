# automated-agents

Webhook-driven coding-agent service. One Node process on EC2, Express
webhook listener, will dispatch to three agent roles (architect, coder,
reviewer) in later phases.

## Phase 0 — hello webhook

This repo at HEAD proves the plumbing end-to-end:

- `pulumi up` provisions a `t3.small` EC2 with Caddy + Node + systemd.
- Caddy auto-fetches a Let's Encrypt cert for a `nip.io` hostname derived
  from the instance's public IP.
- Node process handles `POST /webhook`, verifies the GitHub HMAC
  signature, logs the event, returns `202`.
- GitHub webhook on `baglessdev/agent-poc-target` points at
  `https://<ip-dashed>.nip.io/webhook`.

Expected logs (journalctl -u automated-agents):

    { event: 'issues', action: 'opened', delivery: '<uuid>' }

That's the full Phase 0 acceptance.

## Local dev

    npm install
    npm run build
    GITHUB_WEBHOOK_SECRET=test npm start

Use `ngrok http 8080` + point a test GitHub webhook at it to exercise
the signature check without touching AWS.

## Deploy

See `infra/README.md`.

## Layout

    src/
      main.ts         Express entry + /health + /webhook handler
      webhook.ts      HMAC-SHA256 signature verifier middleware
      config.ts       env-var loader with fail-fast
    infra/
      index.ts        single-file Pulumi stack
      Pulumi.yaml     project metadata
