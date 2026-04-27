import { Octokit } from '@octokit/rest';
import { config } from '../config';

const octokit = new Octokit({ auth: config.githubToken });

export interface Issue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  repoFullName: string;
}

export interface Comment {
  id: number;
  userLogin: string;
  body: string;
  createdAt: string;
  htmlUrl: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  htmlUrl: string;
  userLogin: string;
}

export function parseRepo(full: string): { owner: string; repo: string } {
  const [owner, repo] = full.split('/');
  if (!owner || !repo) {
    throw new Error(`invalid repo full_name: ${full}`);
  }
  return { owner, repo };
}

export async function getIssue(repoFull: string, number: number): Promise<Issue> {
  const { owner, repo } = parseRepo(repoFull);
  const { data } = await octokit.issues.get({ owner, repo, issue_number: number });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    htmlUrl: data.html_url,
    repoFullName: repoFull,
  };
}

export async function listIssueComments(
  repoFull: string,
  number: number,
): Promise<Comment[]> {
  const { owner, repo } = parseRepo(repoFull);
  const data = await octokit.paginate(octokit.issues.listComments, {
    owner,
    repo,
    issue_number: number,
    per_page: 100,
  });
  return data.map((c) => ({
    id: c.id,
    userLogin: c.user?.login ?? '',
    body: c.body ?? '',
    createdAt: c.created_at,
    htmlUrl: c.html_url,
  }));
}

export async function postIssueComment(
  repoFull: string,
  number: number,
  body: string,
): Promise<string> {
  const { owner, repo } = parseRepo(repoFull);
  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  });
  return data.html_url;
}

// Add labels to an issue or PR. GitHub's addLabels endpoint creates
// missing labels on the fly with default styling, so we don't need a
// separate "ensure label exists" call. Used by the coder role to mark
// PRs that didn't pass verify with `agent:verify-failed`.
export async function addLabels(
  repoFull: string,
  number: number,
  labels: string[],
): Promise<void> {
  const { owner, repo } = parseRepo(repoFull);
  await octokit.issues.addLabels({
    owner,
    repo,
    issue_number: number,
    labels,
  });
}

export async function openPullRequest(args: {
  repoFull: string;
  head: string;
  base: string;
  title: string;
  body: string;
}): Promise<string> {
  const { owner, repo } = parseRepo(args.repoFull);
  const { data } = await octokit.pulls.create({
    owner,
    repo,
    head: args.head,
    base: args.base,
    title: args.title,
    body: args.body,
  });
  return data.html_url;
}

// Extract issue numbers referenced by GitHub's "closing keywords" in a PR
// body (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved).
// Case-insensitive. De-duped.
export function parseClosedIssues(prBody: string): number[] {
  if (!prBody) return [];
  const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  const nums = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(prBody)) !== null) {
    nums.add(Number(m[1]));
  }
  return [...nums];
}

export async function getPull(repoFull: string, number: number): Promise<Pull> {
  const { owner, repo } = parseRepo(repoFull);
  const { data } = await octokit.pulls.get({ owner, repo, pull_number: number });
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    headRef: data.head.ref,
    headSha: data.head.sha,
    baseRef: data.base.ref,
    htmlUrl: data.html_url,
    userLogin: data.user?.login ?? '',
  };
}

export async function getPullDiff(repoFull: string, number: number): Promise<string> {
  const { owner, repo } = parseRepo(repoFull);
  const resp = await octokit.request(
    'GET /repos/{owner}/{repo}/pulls/{pull_number}',
    {
      owner,
      repo,
      pull_number: number,
      mediaType: { format: 'diff' },
    },
  );
  // When mediaType.format is 'diff', resp.data is a raw string.
  return resp.data as unknown as string;
}

export interface LineComment {
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  body: string;
}

export interface PullReview {
  id: number;
  userLogin: string;
  body: string;
  state: string;
  submittedAt: string | null;
  htmlUrl: string;
}

export interface PullReviewComment {
  id: number;
  pullRequestReviewId: number | null;
  userLogin: string;
  path: string;
  line: number | null;
  side: 'LEFT' | 'RIGHT' | null;
  body: string;
  createdAt: string;
  htmlUrl: string;
}

export interface PullCommit {
  sha: string;
  message: string;
  authorLogin: string;
  authorDate: string | null;
}

// List reviews posted on a PR, oldest first. Used by the iterate flow to
// find the most recent REQUEST_CHANGES / COMMENT review to address.
export async function listPullReviews(
  repoFull: string,
  number: number,
): Promise<PullReview[]> {
  const { owner, repo } = parseRepo(repoFull);
  const data = await octokit.paginate(octokit.pulls.listReviews, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return data.map((r) => ({
    id: r.id,
    userLogin: r.user?.login ?? '',
    body: r.body ?? '',
    state: r.state ?? '',
    submittedAt: r.submitted_at ?? null,
    htmlUrl: r.html_url ?? '',
  }));
}

// List inline comments on a PR's diff (all reviews combined). Iteration
// fetches these and filters to the latest review's batch.
export async function listPullReviewComments(
  repoFull: string,
  number: number,
): Promise<PullReviewComment[]> {
  const { owner, repo } = parseRepo(repoFull);
  const data = await octokit.paginate(octokit.pulls.listReviewComments, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return data.map((c) => ({
    id: c.id,
    pullRequestReviewId: c.pull_request_review_id ?? null,
    userLogin: c.user?.login ?? '',
    path: c.path,
    line: c.line ?? c.original_line ?? null,
    side: (c.side as 'LEFT' | 'RIGHT' | undefined) ?? null,
    body: c.body ?? '',
    createdAt: c.created_at,
    htmlUrl: c.html_url,
  }));
}

// List commits on a PR (head branch). Used to count prior coder iterations
// via the commit-message marker and enforce the iteration cap.
export async function listPullCommits(
  repoFull: string,
  number: number,
): Promise<PullCommit[]> {
  const { owner, repo } = parseRepo(repoFull);
  const data = await octokit.paginate(octokit.pulls.listCommits, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message ?? '',
    authorLogin: c.author?.login ?? '',
    authorDate: c.commit.author?.date ?? null,
  }));
}

// Post a PR review with optional inline comments. `event` is gated to
// COMMENT or REQUEST_CHANGES — the agent never APPROVES (human-only).
// On GitHub validation failure (e.g. line refs outside the diff), retries
// once without the comments so the summary still lands. Also auto-downgrades
// REQUEST_CHANGES → COMMENT when GitHub rejects with "own pull request"
// (single-identity POC limitation).
export async function postPullReview(args: {
  repoFull: string;
  prNumber: number;
  commitId: string;
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: LineComment[];
}): Promise<{
  url: string;
  inlineCommentsDropped: boolean;
  eventFinal: 'COMMENT' | 'REQUEST_CHANGES';
  downgradedToComment: boolean;
}> {
  const { owner, repo } = parseRepo(args.repoFull);
  const comments =
    args.comments?.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      body: c.body,
    })) ?? [];

  // We may end up downgrading event/stripping comments via retries.
  // Track what actually got posted for the caller's audit log.
  let eventFinal: typeof args.event = args.event;
  let inlineCommentsDropped = false;
  let downgradedToComment = false;

  const tryPost = async (event: typeof args.event, cs: typeof comments, extraBody = '') => {
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: args.prNumber,
      commit_id: args.commitId,
      body: args.body + extraBody,
      event,
      comments: cs,
    });
    return data.html_url;
  };

  const isOwnPrError = (err: unknown): boolean =>
    String((err as { message?: string }).message ?? '').includes(
      'Can not request changes on your own pull request',
    );

  try {
    const url = await tryPost(args.event, comments);
    return { url, inlineCommentsDropped: false, eventFinal, downgradedToComment };
  } catch (err) {
    // Case 1: self-PR REQUEST_CHANGES rejection. Downgrade to COMMENT.
    // Happens when the bot's GitHub identity is the PR author (single-
    // account POC). Architectural fix is a separate reviewer identity;
    // until then, preserve the verdict in the body text and post as COMMENT.
    if (args.event === 'REQUEST_CHANGES' && isOwnPrError(err)) {
      eventFinal = 'COMMENT';
      downgradedToComment = true;
      const note =
        `\n\n---\n_Note: GitHub blocks REQUEST_CHANGES on your own PR. ` +
        `Posted as a comment; see body verdict for the reviewer's actual call._`;
      try {
        const url = await tryPost('COMMENT', comments, note);
        return { url, inlineCommentsDropped, eventFinal, downgradedToComment };
      } catch (err2) {
        // Fall through to comment-stripping retry below with the new event.
        if (comments.length > 0) {
          inlineCommentsDropped = true;
          const url = await tryPost(
            'COMMENT',
            [],
            note +
              `\n\n_Also: ${comments.length} inline comment(s) were dropped ` +
              `because GitHub rejected their line references._`,
          );
          return { url, inlineCommentsDropped, eventFinal, downgradedToComment };
        }
        throw err2;
      }
    }

    // Case 2: inline comment line refs don't match the diff. Retry without
    // them so the summary still lands.
    if (comments.length > 0) {
      inlineCommentsDropped = true;
      const url = await tryPost(
        args.event,
        [],
        `\n\n---\n_Note: ${comments.length} inline comment(s) were ` +
          `dropped because GitHub rejected their line references._`,
      );
      return { url, inlineCommentsDropped, eventFinal, downgradedToComment };
    }

    throw err;
  }
}
