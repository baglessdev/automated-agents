// Entrypoint: webhook listener (Express) + background worker (polls SQLite).
// Phase 3: architect + coder + reviewer.

import express, { type Request } from 'express';
import { verifyGitHubSignature } from './webhook';
import { config } from './config';
import { startWorker, queue } from './worker';
import type { ArchitectPayload, CoderPayload, ReviewerPayload } from './types';

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
    issue?: { number?: number; html_url?: string; pull_request?: unknown };
    comment?: { body?: string; user?: { login?: string } };
    label?: { name?: string };
    repository?: { full_name?: string };
    pull_request?: {
      number?: number;
      html_url?: string;
      head?: { ref?: string };
      user?: { login?: string };
    };
  };

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

  // Route 1: issues.labeled with `agent:arch` → architect job
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

  // Route 2: issue_comment.created starting with /approve → coder job.
  // Ignore PR comments (issue_comment fires for both; PR has `pull_request`).
  if (
    event === 'issue_comment' &&
    body.action === 'created' &&
    body.repository?.full_name &&
    body.issue?.number != null &&
    !body.issue.pull_request &&
    /^\s*\/approve\b/i.test(body.comment?.body ?? '')
  ) {
    const payload: CoderPayload = {
      repo: body.repository.full_name,
      issueNumber: body.issue.number,
      issueUrl: body.issue.html_url ?? '',
    };
    const job = queue.enqueue('coder', payload);
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'enqueued',
        jobId: job.id,
        kind: 'coder',
        repo: payload.repo,
        issue: payload.issueNumber,
        commenter: body.comment?.user?.login,
      }),
    );
  }

  // Route 3: reviewer triggers. Two paths:
  //   (a) pull_request.{opened,reopened} on branch `agent/*` — bot PRs
  //       auto-reviewed on open (no label needed).
  //   (b) pull_request.labeled with `agent:review` — humans opt-in their
  //       own PRs for agent review.
  // Draft PRs skipped.
  if (
    event === 'pull_request' &&
    body.repository?.full_name &&
    body.pull_request?.number != null &&
    !(body.pull_request as { draft?: boolean }).draft
  ) {
    const branch = body.pull_request.head?.ref ?? '';
    const isBotBranch = branch.startsWith('agent/');
    const isOpenOrReopen =
      body.action === 'opened' || body.action === 'reopened';
    const isReviewLabel =
      body.action === 'labeled' && body.label?.name === 'agent:review';

    if ((isBotBranch && isOpenOrReopen) || isReviewLabel) {
      const payload: ReviewerPayload = {
        repo: body.repository.full_name,
        prNumber: body.pull_request.number,
        prUrl: body.pull_request.html_url ?? '',
      };
      const job = queue.enqueue('reviewer', payload);
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'enqueued',
          jobId: job.id,
          kind: 'reviewer',
          repo: payload.repo,
          pr: payload.prNumber,
          trigger: isBotBranch ? 'bot-branch' : 'review-label',
        }),
      );
    }
  }

  res.status(202).end();
});

app.listen(config.port, () => {
  console.log(`automated-agents listening on :${config.port}`);
  startWorker();
});
