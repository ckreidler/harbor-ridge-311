import { createHash } from 'node:crypto';
import { Token } from 'aws-cdk-lib/core';
import type { ActionKey, ActionType, FlowAction, Json } from './actions';

export interface FlowDefinition {
  readonly name: string;
  readonly start: ActionKey;
  readonly actions: readonly FlowAction[];
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

const IDENTIFIER_NAMESPACE = Buffer.from('9864b7d53cac4cfb8346d09fd3f00f49', 'hex');

export function actionId(flowName: string, key: ActionKey): string {
  const hash = createHash('sha1').update(IDENTIFIER_NAMESPACE).update(JSON.stringify([flowName, key])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function targets(action: FlowAction): ActionKey[] {
  return [
    ...(action.next === undefined ? [] : [action.next]),
    ...action.conditions.map((branch) => branch.to),
    ...action.errors.map((branch) => branch.to),
  ];
}

function problems(definition: FlowDefinition): string[] {
  const found: string[] = [];
  const byKey = new Map<ActionKey, FlowAction>();
  for (const action of definition.actions) {
    if (Token.isUnresolved(action.key)) {
      found.push(`action key ${action.key} is a token`);
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
  const reached = new Set<ActionKey>();
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

function transitions(action: FlowAction, id: (key: ActionKey) => string): FlowTransitions {
  if (action.next === undefined) {
    return {};
  }
  const NextAction = id(action.next);
  if (action.conditions.length === 0 && action.errors.length === 0) {
    return { NextAction };
  }
  const Conditions = action.conditions.map((branch) => ({
    NextAction: id(branch.to),
    Condition: { Operator: branch.operator, Operands: [...branch.operands] },
  }));
  const Errors = action.errors.map((branch) => ({ ErrorType: branch.error, NextAction: id(branch.to) }));
  return Conditions.length > 0 ? { NextAction, Conditions, Errors } : { NextAction, Errors, Conditions };
}

export function flow(definition: FlowDefinition): FlowContent {
  if (Token.isUnresolved(definition.name)) {
    throw new Error('flow name must be a literal string, not a token');
  }
  const found = problems(definition);
  if (found.length > 0) {
    throw new Error(`invalid flow ${definition.name}:\n${found.map((problem) => `  - ${problem}`).join('\n')}`);
  }
  const id = (key: ActionKey) => actionId(definition.name, key);
  return {
    Version: '2019-10-30',
    StartAction: id(definition.start),
    Actions: definition.actions.map((action) => ({
      Identifier: id(action.key),
      Type: action.type,
      Parameters: action.parameters,
      Transitions: transitions(action, id),
    })),
  };
}
