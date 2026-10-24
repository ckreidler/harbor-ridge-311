import * as fs from 'node:fs';
import * as path from 'node:path';
import { actionId } from '../lib/flow';
import { MAIN_FLOW_NAME } from '../lib/flows/main-flow';

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/main-flow-0966293.json'),
  'utf8',
)) as { Actions: { Identifier: string }[] };

const keys = fixture.Actions.map((action) => action.Identifier);

interface TransitionDocument {
  NextAction?: string;
  Errors?: Array<{ ErrorType: string; NextAction: string }>;
  Conditions?: Array<{ NextAction: string }>;
}

interface ActionDocument {
  Identifier: string;
  Transitions?: TransitionDocument;
}

export function relabelMainFlow<T extends { StartAction: string; Actions: ActionDocument[] }>(content: T): T {
  const names = new Map(keys.map((key) => [actionId(MAIN_FLOW_NAME, key), key]));
  const name = (id: string) => names.get(id) ?? id;
  return {
    ...content,
    StartAction: name(content.StartAction),
    Actions: content.Actions.map((action) => ({
      ...action,
      Identifier: name(action.Identifier),
      Transitions: action.Transitions && {
        ...action.Transitions,
        ...(action.Transitions.NextAction ? { NextAction: name(action.Transitions.NextAction) } : {}),
        ...(action.Transitions.Conditions
          ? {
            Conditions: action.Transitions.Conditions.map((branch) => ({
              ...branch,
              NextAction: name(branch.NextAction),
            })),
          }
          : {}),
        ...(action.Transitions.Errors
          ? {
            Errors: action.Transitions.Errors.map((branch) => ({
              ...branch,
              NextAction: name(branch.NextAction),
            })),
          }
          : {}),
      },
    })),
  };
}
