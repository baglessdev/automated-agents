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
