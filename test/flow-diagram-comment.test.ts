import type { FlowContent } from '../lib/flow';
import { toMermaid } from '../lib/flow';
import { flowPages } from '../lib/flow/pages';
import {
  FLOW_DIAGRAM_MARKER,
  changedFlows,
  commentId,
  commentPlan,
  diagramComment,
  mermaidFromDiagram,
  snapshotsFromPages,
  stableStringify,
  type FlowSnapshot,
} from '../bin/flow-diagram-comment';

function pages(): FlowSnapshot[] {
  return snapshotsFromPages(flowPages());
}

test('flowPages diagrams come from compiled content', () => {
  const compiled = flowPages();
  const snapshots = pages();
  expect(snapshots.map((flow) => flow.name)).toEqual(compiled.map((flow) => flow.name));
  for (const flow of compiled) {
    expect(flow.content.Version).toBe('2019-10-30');
    expect(mermaidFromDiagram(flow.body, flow.name)).toBe(toMermaid(flow.content));
  }
  expect(changedFlows(snapshots, snapshots)).toEqual([]);
});

test('compiled content differences ignore key order and include parameter-only edits', () => {
  const base = pages();
  const reordered = JSON.parse(stableStringify(base[0].content)) as FlowContent;
  expect(stableStringify({ b: 1, a: { d: true, c: null } })).toBe(stableStringify({ a: { c: null, d: true }, b: 1 }));
  const same = base.map((flow, index) => index === 0 ? { ...flow, content: reordered, mermaid: 'flowchart TD' } : flow);
  expect(changedFlows(base, same)).toEqual([]);

  const edited = structuredClone(base[0].content) as FlowContent;
  edited.Actions[0].Parameters = { ...edited.Actions[0].Parameters, CIProbe: 'changed' };
  const head = base.map((flow, index) => index === 0 ? { ...flow, content: edited } : flow);
  expect(changedFlows(base, head)).toEqual([{ name: base[0].name, mermaid: base[0].mermaid }]);
});

test('missing compiled content falls back to the diagram text', () => {
  const head = pages();
  const legacy = head.map(({ name, mermaid }) => ({ name, mermaid, content: null }));
  expect(changedFlows(legacy, head)).toEqual([]);
  const tweaked = legacy.map((flow, index) => index === 0 ? { ...flow, mermaid: `${flow.mermaid}\n  n_extra["extra"]` } : flow);
  expect(changedFlows(tweaked, head)).toEqual([{ name: head[0].name, mermaid: head[0].mermaid }]);
});

test('added and removed flows are included', () => {
  const snapshots = pages();
  expect(changedFlows(snapshots, snapshots.slice(1))).toEqual([{ name: snapshots[0].name }]);
  expect(changedFlows(snapshots.slice(1), snapshots)).toEqual([{ name: snapshots[0].name, mermaid: snapshots[0].mermaid }]);
});

test('the sticky comment is one mermaid block per changed flow', () => {
  const body = diagramComment([
    { name: 'HarborRidge311-Main', mermaid: 'flowchart TD\n  n_a["a"]' },
    { name: 'Gone' },
  ]);
  expect(body.startsWith(`${FLOW_DIAGRAM_MARKER}\n`)).toBe(true);
  expect(body).toContain('Compiled flow content changed.');
  expect(body).toContain('### HarborRidge311-Main\n\n```mermaid\nflowchart TD\n  n_a["a"]\n```');
  expect(body).toContain('### Gone\n\nRemoved.');
  expect(diagramComment([])).toBe(`${FLOW_DIAGRAM_MARKER}\n\nNo compiled flow content changed.`);
  expect(() => mermaidFromDiagram('# title\n', 'HarborRidge311-Main')).toThrow(/HarborRidge311-Main/);
});

test('an existing sticky comment is updated in place', () => {
  expect(commentId([
    { id: 1, body: 'hello' },
    { id: 2, body: `note\n${FLOW_DIAGRAM_MARKER}\n` },
  ], FLOW_DIAGRAM_MARKER)).toBe(2);
  expect(commentId([{ id: 1, body: 'nope' }], FLOW_DIAGRAM_MARKER)).toBeUndefined();
  expect(commentPlan([], undefined)).toEqual({ action: 'skip' });
  const update = commentPlan([], 5);
  expect(update).toMatchObject({ action: 'update', id: 5 });
  expect(commentPlan([{ name: 'HarborRidge311-Queue', mermaid: 'flowchart TD' }], undefined)).toMatchObject({
    action: 'create',
  });
  expect(commentPlan([{ name: 'HarborRidge311-Queue', mermaid: 'flowchart TD' }], 9)).toMatchObject({
    action: 'update',
    id: 9,
  });
});
