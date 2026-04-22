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
