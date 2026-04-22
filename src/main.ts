// Phase 0 entrypoint: Express webhook listener + health check.
// Deliberately minimal — later phases add queue + worker loop + role
// dispatchers. This file proves the HTTPS + HMAC path end-to-end.

import express, { type Request } from 'express';
import { verifyGitHubSignature } from './webhook';
import { config } from './config';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const app = express();

// express.json() with a `verify` hook so webhook.ts can recompute HMAC
// against the *exact* bytes GitHub sent, not the JSON-reparsed body.
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as RawBodyRequest).rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.post('/webhook', verifyGitHubSignature, (req, res) => {
  const event = req.get('x-github-event');
  const delivery = req.get('x-github-delivery');
  const body = req.body as { action?: string; issue?: { number?: number }; pull_request?: { number?: number } };

  console.log(
    JSON.stringify({
      event,
      action: body.action,
      delivery,
      issue: body.issue?.number,
      pr: body.pull_request?.number,
    }),
  );

  res.status(202).end();
});

app.listen(config.port, () => {
  console.log(`automated-agents listening on :${config.port}`);
});
