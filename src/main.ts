// Entrypoint: webhook listener (Express) + background worker (polls SQLite).
// Phase 1: architect only.

import express, { type Request } from 'express';
import { verifyGitHubSignature } from './webhook';
import { config } from './config';
import { startWorker, queue } from './worker';
import type { ArchitectPayload } from './types';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

const app = express();

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
  const body = req.body as {
    action?: string;
    issue?: { number?: number; html_url?: string };
    label?: { name?: string };
    repository?: { full_name?: string };
    pull_request?: { number?: number };
  };

  // Always log the event; keeps delivery history visible even for
  // events we don't act on.
  console.log(
    JSON.stringify({
      event,
      action: body.action,
      delivery,
      issue: body.issue?.number,
      pr: body.pull_request?.number,
      label: body.label?.name,
      repo: body.repository?.full_name,
    }),
  );

  // Route: issues.labeled with `agent:arch` → enqueue architect job
  if (
    event === 'issues' &&
    body.action === 'labeled' &&
    body.label?.name === config.archLabel &&
    body.repository?.full_name &&
    body.issue?.number != null
  ) {
    const payload: ArchitectPayload = {
      repo: body.repository.full_name,
      issueNumber: body.issue.number,
      issueUrl: body.issue.html_url ?? '',
    };
    const job = queue.enqueue('architect', payload);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'enqueued',
        jobId: job.id,
        kind: 'architect',
        repo: payload.repo,
        issue: payload.issueNumber,
      }),
    );
  }

  res.status(202).end();
});

app.listen(config.port, () => {
  console.log(`automated-agents listening on :${config.port}`);
  startWorker();
});
