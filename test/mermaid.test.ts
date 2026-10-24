import * as fs from 'node:fs';
import * as path from 'node:path';
import { flowPages } from '../bin/diagrams';
import {
  checkHoursOfOperation,
  compare,
  disconnectParticipant,
  equals,
  exists,
  flow,
  messageParticipant,
  toMermaid,
  type FlowContent,
} from '../lib/flow';

test('toMermaid labels actions and branches in flow order', () => {
  const compiled = flow({
    name: 'Test',
    start: 'hours',
    actions: [
      checkHoursOfOperation('hours', { HoursOfOperationId: 'h' }, {
        next: 'open',
        inHours: 'open',
        outOfHours: 'closed',
        error: 'closed',
      }),
      messageParticipant('open', { Text: 'hi' }, { next: 'end', error: 'end' }),
      compare('closed', { ComparisonValue: '$.Channel' }, {
        next: 'end',
        conditions: [equals('CHAT', 'open'), exists('end')],
        noMatch: 'end',
      }),
      disconnectParticipant('end'),
    ],
  });

  expect(toMermaid(compiled)).toBe([
    'flowchart TD',
    '  n_hours["hours<br/>CheckHoursOfOperation"]',
    '  n_open["open<br/>MessageParticipant"]',
    '  n_closed["closed<br/>Compare"]',
    '  n_end["end<br/>DisconnectParticipant"]',
    '  n_hours -->|"next"| n_open',
    '  n_hours -->|"inHours"| n_open',
    '  n_hours -->|"outOfHours"| n_closed',
    '  n_hours -->|"NoMatchingError"| n_closed',
    '  n_open -->|"next"| n_end',
    '  n_open -->|"NoMatchingError"| n_end',
    '  n_closed -->|"next"| n_end',
    '  n_closed -->|"CHAT"| n_open',
    '  n_closed -->|"Exists"| n_end',
    '  n_closed -->|"NoMatchingCondition"| n_end',
  ].join('\n'));
  expect(toMermaid(compiled)).toBe(toMermaid(compiled));
});

test('toMermaid escapes labels that would break flowchart syntax', () => {
  const compiled: FlowContent = {
    Version: '2019-10-30',
    StartAction: 'a"b',
    Actions: [{
      Identifier: 'a"b',
      Type: 'DisconnectParticipant',
      Parameters: {},
      Transitions: {},
    }],
  };
  expect(toMermaid(compiled)).toBe([
    'flowchart TD',
    '  n_a_b["a#quot;b<br/>DisconnectParticipant"]',
  ].join('\n'));
});

test('committed flow diagrams match the compiler', () => {
  for (const page of flowPages()) {
    const file = path.join('docs/flows', `${page.name}.md`);
    const committed = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (committed !== page.body) {
      throw new Error(`${file} is out of date. Run npm run diagrams`);
    }
  }
});
