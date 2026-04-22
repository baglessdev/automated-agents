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

// Post a PR review with optional inline comments. `event` is gated to
// COMMENT or REQUEST_CHANGES — the agent never APPROVES (human-only).
// On GitHub validation failure (e.g. line refs outside the diff), retries
// once without the comments so the summary still lands.
export async function postPullReview(args: {
  repoFull: string;
  prNumber: number;
  commitId: string;
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: LineComment[];
}): Promise<{ url: string; inlineCommentsDropped: boolean }> {
  const { owner, repo } = parseRepo(args.repoFull);
  const comments =
    args.comments?.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      body: c.body,
    })) ?? [];

  try {
    const { data } = await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: args.prNumber,
      commit_id: args.commitId,
      body: args.body,
      event: args.event,
      comments,
    });
    return { url: data.html_url, inlineCommentsDropped: false };
  } catch (err) {
    // Most common failure: a line number doesn't match a position in the
    // diff. Retry with just the summary body so we don't lose the review.
    if (comments.length > 0) {
      const { data } = await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: args.prNumber,
        commit_id: args.commitId,
        body:
          args.body +
          `\n\n---\n_Note: ${comments.length} inline comment(s) were ` +
          `dropped because GitHub rejected their line references. ` +
          `See the Bugs / correctness section above for the content._`,
        event: args.event,
      });
      return { url: data.html_url, inlineCommentsDropped: true };
    }
    throw err;
  }
}
