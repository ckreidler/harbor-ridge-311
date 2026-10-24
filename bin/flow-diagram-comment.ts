import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FLOW_DIAGRAM_MARKER = '<!-- harbor-ridge-flow-diagrams -->';

const COMMENT_LIMIT = 65536;

export interface FlowSnapshot {
  readonly name: string;
  readonly content: unknown;
  readonly mermaid: string;
}

export interface ChangedFlow {
  readonly name: string;
  readonly mermaid?: string;
}

export type CommentPlan =
  | { readonly action: 'skip' }
  | { readonly action: 'create'; readonly body: string }
  | { readonly action: 'update'; readonly id: number; readonly body: string };

interface PagesModule {
  flowPages?: () => Array<{ name: string; body: string; content?: unknown }>;
}

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

export function mermaidFromDiagram(body: string, name = 'diagram page'): string {
  const match = body.match(/```mermaid\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error(`${name} is missing a mermaid block`);
  return match[1];
}

export function snapshotsFromPages(
  pages: ReadonlyArray<{ name: string; body: string; content?: unknown }>,
): FlowSnapshot[] {
  return pages.map((page) => {
    if (page.content === undefined || page.content === null) {
      throw new Error(`${page.name} is missing compiled content`);
    }
    return {
      name: page.name,
      content: page.content,
      mermaid: mermaidFromDiagram(page.body, page.name),
    };
  });
}

function compiled(flow: FlowSnapshot): unknown {
  if (flow.content === null || flow.content === undefined) {
    throw new Error(`${flow.name} is missing compiled content`);
  }
  return flow.content;
}

function differs(left: FlowSnapshot, right: FlowSnapshot): boolean {
  return stableStringify(compiled(left)) !== stableStringify(compiled(right));
}

export function changedFlows(base: readonly FlowSnapshot[], head: readonly FlowSnapshot[]): ChangedFlow[] {
  const baseByName = new Map(base.map((flow) => [flow.name, flow]));
  const headNames = new Set(head.map((flow) => flow.name));
  const changed: ChangedFlow[] = [];
  for (const flow of head) {
    const previous = baseByName.get(flow.name);
    if (!previous || differs(previous, flow)) changed.push({ name: flow.name, mermaid: flow.mermaid });
  }
  for (const flow of base) {
    if (!headNames.has(flow.name)) changed.push({ name: flow.name });
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

export async function loadFlowSnapshots(root: string): Promise<FlowSnapshot[]> {
  const file = path.join(root, 'lib/flow/pages.ts');
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const loaded = await import(pathToFileURL(file).href) as PagesModule;
  if (typeof loaded.flowPages !== 'function') throw new Error(`${file} does not export flowPages`);
  try {
    return snapshotsFromPages(loaded.flowPages());
  } catch (error) {
    if (error instanceof Error) throw new Error(`${error.message} (${file})`);
    throw error;
  }
}

function revision(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/^~-]*$/.test(value)) throw new Error(`invalid revision ${value}`);
  return git(['rev-parse', '--verify', `${value}^{commit}`]);
}

function unlinkModules(root: string): void {
  const modules = path.join(root, 'node_modules');
  try {
    if (fs.lstatSync(modules).isSymbolicLink()) fs.unlinkSync(modules);
  } catch {
    return;
  }
}

function ensureDependencies(root: string): void {
  const modules = path.join(root, 'node_modules');
  if (fs.existsSync(modules)) return;
  const lock = path.join(root, 'package-lock.json');
  const localLock = path.join(repoRoot(), 'package-lock.json');
  if (fs.existsSync(lock) && fs.existsSync(localLock) && fs.readFileSync(lock).equals(fs.readFileSync(localLock))) {
    fs.symlinkSync(path.join(repoRoot(), 'node_modules'), modules);
    return;
  }
  execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
}

function clearWorktree(worktree: string): void {
  unlinkModules(worktree);
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: repoRoot(), stdio: 'ignore' });
  } catch {
    fs.rmSync(worktree, { recursive: true, force: true });
  }
  execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot(), stdio: 'ignore' });
}

async function snapshotsAt(sha: string): Promise<FlowSnapshot[]> {
  const resolved = revision(sha);
  if (resolved === revision('HEAD')) return loadFlowSnapshots(repoRoot());
  const worktree = path.join(os.tmpdir(), `flow-diagrams-${resolved}`);
  clearWorktree(worktree);
  execFileSync('git', ['worktree', 'add', '--detach', worktree, resolved], {
    cwd: repoRoot(),
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    ensureDependencies(worktree);
    return await loadFlowSnapshots(worktree);
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
  const base = await snapshotsAt(baseSha);
  const head = await snapshotsAt(headSha);
  const changed = changedFlows(base, head);
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
  console.error(`flow diagrams: ${base.length} base, ${head.length} head, ${changed.length} changed, ${plan.action}`);
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
