// Entrypoint: webhook listener (Express) + background worker (long-polls
// SQS). Phase 3: architect + coder + reviewer.

import express, { type Request } from 'express';
import { verifyGitHubSignature } from './webhook';
import { config } from './config';
import { startWorker, queue } from './worker';
import type {
  ArchitectPayload,
  CoderPayload,
  IteratePayload,
  ReviewerPayload,
} from './types';

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

app.post('/webhook', verifyGitHubSignature, async (req, res) => {
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

  // dedupKey is the GitHub delivery ID. SQS FIFO uses it as
  // MessageDeduplicationId, giving us a 5-min idempotency window that
  // covers GitHub's webhook retry behavior. Falls back to undefined
  // (which the queue replaces with the job UUID) if the header is missing.
  const dedupKey = delivery ?? undefined;

  try {
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
      const job = await queue.enqueue('architect', payload, dedupKey);
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
      const job = await queue.enqueue('coder', payload, dedupKey);
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

    // Route 2b: issue_comment.created starting with /iterate ON A PR →
    // coder_iterate job. issue_comment fires for both issues and PRs; PR
    // comments carry `issue.pull_request` (the opposite of Route 2's gate).
    if (
      event === 'issue_comment' &&
      body.action === 'created' &&
      body.repository?.full_name &&
      body.issue?.number != null &&
      body.issue.pull_request &&
      /^\s*\/iterate\b/i.test(body.comment?.body ?? '')
    ) {
      const payload: IteratePayload = {
        repo: body.repository.full_name,
        prNumber: body.issue.number,
        prUrl: body.issue.html_url ?? '',
        requestedBy: body.comment?.user?.login ?? '',
      };
      const job = await queue.enqueue('coder_iterate', payload, dedupKey);
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'enqueued',
          jobId: job.id,
          kind: 'coder_iterate',
          repo: payload.repo,
          pr: payload.prNumber,
          commenter: payload.requestedBy,
        }),
      );
    }

    // Route 3: reviewer triggers. Three paths:
    //   (a) pull_request.{opened,reopened} on branch `agent/*` — bot PRs
    //       auto-reviewed on open (no label needed).
    //   (b) pull_request.labeled with `agent:review` — humans opt-in their
    //       own PRs for agent review.
    //   (c) pull_request.synchronize on branch `agent/*` — new commits
    //       pushed to a bot PR (including by the coder_iterate role) auto
    //       re-review. Does NOT fire on human-opt-in PRs; they'd re-run
    //       via a new `agent:review` label toggle if needed.
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
      const isBotResync = body.action === 'synchronize' && isBotBranch;

      if ((isBotBranch && isOpenOrReopen) || isReviewLabel || isBotResync) {
        const payload: ReviewerPayload = {
          repo: body.repository.full_name,
          prNumber: body.pull_request.number,
          prUrl: body.pull_request.html_url ?? '',
        };
        const job = await queue.enqueue('reviewer', payload, dedupKey);
        const trigger = isBotResync
          ? 'bot-branch-sync'
          : isBotBranch
            ? 'bot-branch'
            : 'review-label';
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'enqueued',
            jobId: job.id,
            kind: 'reviewer',
            repo: payload.repo,
            pr: payload.prNumber,
            trigger,
          }),
        );
      }
    }

    res.status(202).end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'enqueue_failed',
        delivery,
        error: msg,
      }),
    );
    // 5xx tells GitHub to retry. FIFO dedup on the delivery id makes
    // retries safe — the message will be deduped if our enqueue partially
    // succeeded and the response was the part that failed.
    res.status(500).end();
  }
});

app.listen(config.port, () => {
  console.log(`automated-agents listening on :${config.port}`);
  startWorker();
});
