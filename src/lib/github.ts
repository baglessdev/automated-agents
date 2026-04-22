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
