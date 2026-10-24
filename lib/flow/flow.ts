import { Token } from 'aws-cdk-lib/core';
import type { ActionType, CustomerQueueAction, FlowAction, InboundContactAction, Json } from './actions';

export const CONTACT_FLOW = 'CONTACT_FLOW' as const;
export const CUSTOMER_QUEUE = 'CUSTOMER_QUEUE' as const;

export type ConnectFlowType = typeof CONTACT_FLOW | typeof CUSTOMER_QUEUE;

export type ActionsForFlowType = {
  CONTACT_FLOW: InboundContactAction;
  CUSTOMER_QUEUE: CustomerQueueAction;
};

export interface FlowDefinition<T extends ConnectFlowType> {
  readonly name: string;
  readonly type: T;
  readonly start: string;
  readonly actions: readonly ActionsForFlowType[T][];
}

export interface FlowTransitions {
  NextAction?: string;
  Conditions?: { NextAction: string; Condition: { Operator: 'Equals' | 'Exists'; Operands: string[] } }[];
  Errors?: { ErrorType: string; NextAction: string }[];
}

export interface FlowContentAction {
  Identifier: string;
  Type: ActionType;
  Parameters: { readonly [name: string]: Json };
  Transitions: FlowTransitions;
}

export interface FlowContent {
  Version: '2019-10-30';
  StartAction: string;
  Actions: FlowContentAction[];
}

const IDENTIFIER_LIMIT = 50;
const REJECTED_IDENTIFIER_CHARACTERS = /[%:()\\/=$,;\[\]{}]/;
const REJECTED_IDENTIFIERS = new Set([
  '__proto__',
  'constructor',
  '__defineGetter__',
  '__defineSetter__',
  'toString',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'valueOf',
]);

function invalidIdentifier(key: string): string | undefined {
  if (
    key.length < 1
    || key.length > IDENTIFIER_LIMIT
    || REJECTED_IDENTIFIER_CHARACTERS.test(key)
    || REJECTED_IDENTIFIERS.has(key)
  ) {
    return `action key "${key}" is not a valid Identifier`;
  }
  return undefined;
}

function targets(action: FlowAction): string[] {
  if (action.type === 'DisconnectParticipant') {
    return [];
  }
  return [
    action.next,
    ...action.conditions.map((branch) => branch.to),
    ...action.errors.map((branch) => branch.to),
  ];
}

function problems(definition: {
  readonly start: string;
  readonly actions: readonly FlowAction[];
}): string[] {
  const found: string[] = [];
  const byKey = new Map<string, FlowAction>();
  for (const action of definition.actions) {
    if (Token.isUnresolved(action.key)) {
      found.push(`action key ${action.key} is a token`);
    } else {
      const invalid = invalidIdentifier(action.key);
      if (invalid !== undefined) {
        found.push(invalid);
      }
    }
    if (byKey.has(action.key)) {
      found.push(`duplicate action key "${action.key}"`);
    }
    byKey.set(action.key, action);
  }
  for (const action of definition.actions) {
    for (const target of targets(action)) {
      if (!byKey.has(target)) {
        found.push(`"${action.key}" transitions to undefined action "${target}"`);
      }
    }
  }
  if (!byKey.has(definition.start)) {
    found.push(`start action "${definition.start}" is not defined`);
    return found;
  }
  const reached = new Set<string>();
  const pending = [definition.start];
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    const action = byKey.get(key);
    if (reached.has(key) || !action) {
      continue;
    }
    reached.add(key);
    pending.push(...targets(action));
  }
  for (const key of byKey.keys()) {
    if (!reached.has(key)) {
      found.push(`action "${key}" is unreachable from "${definition.start}"`);
    }
  }
  return found;
}

function transitions(action: FlowAction): FlowTransitions {
  if (action.type === 'DisconnectParticipant') {
    return {};
  }
  const NextAction = action.next;
  if (
    action.conditions.length === 0
    && action.errors.length === 0
    && action.type !== 'MessageParticipantIteratively'
  ) {
    return { NextAction };
  }
  return {
    NextAction,
    Conditions: action.conditions.map((branch) => ({
      NextAction: branch.to,
      Condition: { Operator: branch.operator, Operands: [...branch.operands] },
    })),
    Errors: action.errors.map((branch) => ({ ErrorType: branch.error, NextAction: branch.to })),
  };
}

export function flow<T extends ConnectFlowType>(definition: FlowDefinition<T>): FlowContent {
  if (Token.isUnresolved(definition.name)) {
    throw new Error('flow name must be a literal string, not a token');
  }
  const found = problems(definition);
  if (found.length > 0) {
    throw new Error(`invalid flow ${definition.name}:\n${found.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  return {
    Version: '2019-10-30',
    StartAction: definition.start,
    Actions: definition.actions.map((action) => ({
      Identifier: action.key,
      Type: action.type,
      Parameters: action.parameters,
      Transitions: transitions(action),
    })),
  };
}
