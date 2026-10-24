import { toMermaid } from '../lib/flow';
import { flowPages } from '../lib/flow/pages';
import {
  FLOW_DIAGRAM_MARKER,
  changedFlows,
  commentId,
  commentPlan,
  contactFlowContents,
  diagramComment,
  headDiagrams,
  stableStringify,
} from '../bin/flow-diagram-comment';

function flows(entries: ReadonlyArray<[string, unknown]>): Map<string, unknown> {
  return new Map(entries);
}

test('contact flows are keyed by Name and keep Content as synthesized', () => {
  const content = { 'Fn::Join': ['', ['{"Text":"wait"', { Ref: 'PromptsByChannel' }, '}'] ] };
  const parsed = contactFlowContents({
    Resources: {
      SiteBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'site' } },
      QueueFlow: {
        Type: 'AWS::Connect::ContactFlow',
        Properties: { Name: 'HarborRidge311-Queue', Content: content, Type: 'CUSTOMER_QUEUE' },
      },
    },
  });
  expect([...parsed.keys()]).toEqual(['HarborRidge311-Queue']);
  expect(parsed.get('HarborRidge311-Queue')).toEqual(content);
  expect(() => contactFlowContents({
    Resources: {
      One: { Type: 'AWS::Connect::ContactFlow', Properties: { Name: 'Same', Content: 'a' } },
      Two: { Type: 'AWS::Connect::ContactFlow', Properties: { Name: 'Same', Content: 'b' } },
    },
  })).toThrow('duplicate ContactFlow name Same');
});

test('Content comparison ignores key order and detects parameter-only edits', () => {
  expect(stableStringify({ b: 1, a: { 'Fn::Sub': '${Arn}' } })).toBe(stableStringify({ a: { 'Fn::Sub': '${Arn}' }, b: 1 }));
  const diagrams = new Map([['HarborRidge311-Queue', 'flowchart TD']]);
  const base = flows([
    ['HarborRidge311-Queue', { b: 1, 'Fn::Join': ['', ['{"Text":"', { 'Fn::GetAtt': ['PromptsByChannel', 'Arn'] }]] }],
  ]);
  const reordered = flows([
    ['HarborRidge311-Queue', { 'Fn::Join': ['', ['{"Text":"', { 'Fn::GetAtt': ['PromptsByChannel', 'Arn'] }]], b: 1 }],
  ]);
  expect(changedFlows(base, reordered, diagrams)).toEqual([]);
  const edited = flows([
    ['HarborRidge311-Queue', { 'Fn::Join': ['', ['{"Text":"changed"', { 'Fn::GetAtt': ['PromptsByChannel', 'Arn'] }]], b: 1 }],
  ]);
  expect(changedFlows(base, edited, diagrams)).toEqual([
    { name: 'HarborRidge311-Queue', mermaid: 'flowchart TD' },
  ]);
});

test('added and removed flows are included', () => {
  const diagrams = new Map([
    ['HarborRidge311-Main', 'flowchart TD\n  n_a["a"]'],
    ['HarborRidge311-Queue', 'flowchart TD\n  n_q["q"]'],
  ]);
  const base = flows([['HarborRidge311-Queue', 'queue'], ['HarborRidge311-Main', 'main']]);
  const head = flows([['HarborRidge311-Main', 'main']]);
  expect(changedFlows(base, head, diagrams)).toEqual([{ name: 'HarborRidge311-Queue' }]);
  expect(changedFlows(head, base, diagrams)).toEqual([
    { name: 'HarborRidge311-Queue', mermaid: 'flowchart TD\n  n_q["q"]' },
  ]);
  expect(() => changedFlows(head, flows([['Extra', { 'Fn::Sub': '${X}' }]]), diagrams)).toThrow('no diagram for Extra');
});

test('head diagrams come from flowPages', () => {
  const diagrams = headDiagrams();
  expect([...diagrams.keys()]).toEqual(flowPages().map((page) => page.name));
  for (const page of flowPages()) {
    expect(diagrams.get(page.name)).toBe(toMermaid(page.content));
  }
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
