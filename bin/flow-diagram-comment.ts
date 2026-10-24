import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toMermaid } from '../lib/flow/mermaid';
import { flowPages } from '../lib/flow/pages';

export const FLOW_DIAGRAM_MARKER = '<!-- harbor-ridge-flow-diagrams -->';

const COMMENT_LIMIT = 65536;

export interface ChangedFlow {
  readonly name: string;
  readonly mermaid?: string;
}

export type CommentPlan =
  | { readonly action: 'skip' }
  | { readonly action: 'create'; readonly body: string }
  | { readonly action: 'update'; readonly id: number; readonly body: string };

interface PullRequestEvent {
  number?: number;
  base?: { sha?: string };
  head?: { sha?: string };
}

let repositoryRoot: string | undefined;

function repoRoot(): string {
  if (repositoryRoot === undefined) {
    repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  }
  return repositoryRoot;
}

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: repoRoot(), encoding: 'utf8' }).trim();
}

export function stableStringify(value: unknown): string {
  if (typeof value === 'undefined') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => typeof record[key] !== 'undefined').sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function contactFlowContents(template: unknown): Map<string, unknown> {
  if (typeof template !== 'object' || template === null) throw new Error('ConnectStack template is not an object');
  const resources = (template as { Resources?: unknown }).Resources;
  if (typeof resources !== 'object' || resources === null) throw new Error('ConnectStack template has no Resources');
  const flows = new Map<string, unknown>();
  for (const [logicalId, value] of Object.entries(resources)) {
    if (typeof value !== 'object' || value === null) continue;
    const resource = value as { Type?: unknown; Properties?: { Name?: unknown; Content?: unknown } };
    if (resource.Type !== 'AWS::Connect::ContactFlow') continue;
    const name = resource.Properties?.Name;
    if (typeof name !== 'string') throw new Error(`ContactFlow ${logicalId} Name is not a string`);
    if (flows.has(name)) throw new Error(`duplicate ContactFlow name ${name}`);
    flows.set(name, resource.Properties?.Content);
  }
  return flows;
}

export function headDiagrams(): Map<string, string> {
  return new Map(flowPages().map((page) => [page.name, toMermaid(page.content)]));
}

export function changedFlows(
  base: ReadonlyMap<string, unknown>,
  head: ReadonlyMap<string, unknown>,
  diagrams: ReadonlyMap<string, string>,
): ChangedFlow[] {
  const changed: ChangedFlow[] = [];
  for (const [name, content] of head) {
    if (!base.has(name) || stableStringify(base.get(name)) !== stableStringify(content)) {
      const mermaid = diagrams.get(name);
      if (mermaid === undefined) throw new Error(`no diagram for ${name}`);
      changed.push({ name, mermaid });
    }
  }
  for (const name of base.keys()) {
    if (!head.has(name)) changed.push({ name });
  }
  return changed;
}

export function diagramComment(changed: readonly ChangedFlow[]): string {
  const lines = [FLOW_DIAGRAM_MARKER, ''];
  if (changed.length === 0) {
    lines.push('No compiled flow content changed.');
    return lines.join('\n');
  }
  lines.push('Compiled flow content changed.');
  for (const flow of changed) {
    lines.push('', `### ${flow.name}`);
    if (flow.mermaid === undefined) {
      lines.push('', 'Removed.');
      continue;
    }
    lines.push('', '```mermaid', flow.mermaid, '```');
  }
  return `${lines.join('\n')}\n`;
}

export function commentId(
  comments: ReadonlyArray<{ id: number; body?: string }>,
  marker: string,
): number | undefined {
  return comments.find((comment) => comment.body?.includes(marker))?.id;
}

export function commentPlan(changed: readonly ChangedFlow[], existingId: number | undefined): CommentPlan {
  if (changed.length === 0 && existingId === undefined) return { action: 'skip' };
  const body = diagramComment(changed);
  if (Buffer.byteLength(body, 'utf8') > COMMENT_LIMIT) {
    throw new Error(`flow diagram comment is ${Buffer.byteLength(body, 'utf8')} bytes`);
  }
  if (existingId === undefined) return { action: 'create', body };
  return { action: 'update', id: existingId, body };
}

function revision(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/.test(value)) throw new Error(`invalid revision ${value}`);
  return git(['rev-parse', '--verify', `${value}^{commit}`]);
}

function unlinkIfSymlink(file: string): void {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file);
  } catch {
    return;
  }
}

function sameLockfile(root: string, relativeLock: string): boolean {
  const lock = path.join(root, relativeLock);
  const localLock = path.join(repoRoot(), relativeLock);
  return fs.existsSync(lock) && fs.existsSync(localLock) && fs.readFileSync(lock).equals(fs.readFileSync(localLock));
}

function ensureInstalled(root: string, relativeModules: string, relativeLock: string, install: () => void): void {
  const modules = path.join(root, relativeModules);
  if (fs.existsSync(modules)) return;
  if (sameLockfile(root, relativeLock)) {
    fs.symlinkSync(path.join(repoRoot(), relativeModules), modules);
    return;
  }
  install();
}

function ensureDependencies(root: string): void {
  ensureInstalled(root, 'node_modules', 'package-lock.json', () => {
    execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  });
  if (!fs.existsSync(path.join(root, 'website', 'package.json'))) return;
  ensureInstalled(root, path.join('website', 'node_modules'), path.join('website', 'package-lock.json'), () => {
    execFileSync('npm', ['ci', '--ignore-scripts', '--prefix', 'website'], { cwd: root, stdio: 'inherit' });
  });
}

function synthesize(root: string): Map<string, unknown> {
  execFileSync('npx', ['cdk', 'synth'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' },
  });
  const file = path.join(root, 'cdk.out', 'ConnectStack.template.json');
  return contactFlowContents(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
}

function clearWorktree(worktree: string): void {
  unlinkIfSymlink(path.join(worktree, 'node_modules'));
  unlinkIfSymlink(path.join(worktree, 'website', 'node_modules'));
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot(), stdio: 'ignore' });
  } catch {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot(), stdio: 'ignore' });
}

function flowsAt(sha: string): Map<string, unknown> {
  const resolved = revision(sha);
  if (resolved === revision('HEAD')) return synthesize(repoRoot());
  const worktree = path.join(os.tmpdir(), `flow-diagrams-${resolved}`);
  clearWorktree(worktree);
  execFileSync('git', ['worktree', 'add', '--detach', worktree, resolved], {
    cwd: repoRoot(),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    ensureDependencies(worktree);
    return synthesize(worktree);
  } finally {
    clearWorktree(worktree);
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${name}`);
  return value;
}

function eventPullRequest(): PullRequestEvent | undefined {
  const file = process.env.GITHUB_EVENT_PATH;
  if (!file || !fs.existsSync(file)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('pull_request' in parsed)) return undefined;
  const pullRequest = (parsed as { pull_request?: unknown }).pull_request;
  if (typeof pullRequest !== 'object' || pullRequest === null) return undefined;
  return pullRequest as PullRequestEvent;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'harbor-ridge-flow-diagrams',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function github(token: string, method: string, pathname: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers: {
      ...githubHeaders(token),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`GitHub ${method} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  return text === '' ? undefined : JSON.parse(text) as unknown;
}

async function listComments(token: string, repo: string, pr: number): Promise<Array<{ id: number; body?: string }>> {
  const comments: Array<{ id: number; body?: string }> = [];
  for (let page = 1; page <= 20; page += 1) {
    const listed = await github(token, 'GET', `/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(listed)) throw new Error('GitHub comment list was not an array');
    const batch = listed.flatMap((item) => {
      if (typeof item !== 'object' || item === null || typeof (item as { id?: unknown }).id !== 'number') return [];
      const body = (item as { body?: unknown }).body;
      return [{ id: (item as { id: number }).id, body: typeof body === 'string' ? body : undefined }];
    });
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

async function publish(token: string, repo: string, pr: number, plan: Exclude<CommentPlan, { action: 'skip' }>): Promise<void> {
  if (plan.action === 'create') {
    await github(token, 'POST', `/repos/${repo}/issues/${pr}/comments`, { body: plan.body });
    return;
  }
  await github(token, 'PATCH', `/repos/${repo}/issues/comments/${plan.id}`, { body: plan.body });
}

function repository(value: string): string {
  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) throw new Error(`invalid repository ${value}`);
  return value;
}

function pullNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid pull request ${value}`);
  return Number(value);
}

async function main(): Promise<void> {
  const pullRequest = eventPullRequest();
  const baseSha = option('--base') ?? pullRequest?.base?.sha;
  const headSha = option('--head') ?? pullRequest?.head?.sha;
  if (!baseSha || !headSha) throw new Error('missing base or head sha');
  const base = flowsAt(baseSha);
  const head = flowsAt(headSha);
  const changed = changedFlows(base, head, headDiagrams());
  const token = process.env.GITHUB_TOKEN;
  let existingId: number | undefined;
  let repo: string | undefined;
  let pr: number | undefined;
  if (token) {
    const repoText = option('--repo') ?? process.env.GITHUB_REPOSITORY;
    const prText = option('--pr') ?? (pullRequest?.number === undefined ? undefined : String(pullRequest.number));
    if (!repoText || !prText) throw new Error('missing repository or pull request number');
    repo = repository(repoText);
    pr = pullNumber(prText);
    existingId = commentId(await listComments(token, repo, pr), FLOW_DIAGRAM_MARKER);
  }
  const plan = commentPlan(changed, existingId);
  console.error(`flow diagrams: ${base.size} base, ${head.size} head, ${changed.length} changed, ${plan.action}`);
  if (plan.action === 'skip') return;
  console.log(plan.body);
  if (!token || repo === undefined || pr === undefined) return;
  await publish(token, repo, pr, plan);
}

const entry = process.argv[1];
if (entry !== undefined && path.basename(entry).startsWith('flow-diagram-comment')) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
