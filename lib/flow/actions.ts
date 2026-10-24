export type ActionKey = string;

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export type ActionType =
  | 'UpdateFlowLoggingBehavior'
  | 'UpdateContactTextToSpeechVoice'
  | 'EvaluateDataTableValues'
  | 'MessageParticipant'
  | 'CreateWisdomSession'
  | 'InvokeLambdaFunction'
  | 'ConnectParticipantWithLexBot'
  | 'Compare'
  | 'UpdateContactAttributes'
  | 'CheckHoursOfOperation'
  | 'UpdateContactEventHooks'
  | 'UpdateContactTargetQueue'
  | 'TransferContactToQueue'
  | 'CreateCase'
  | 'GetCase'
  | 'Wait'
  | 'DisconnectParticipant';

export interface ConditionBranch {
  readonly operator: 'Equals' | 'Exists';
  readonly operands: readonly string[];
  readonly to: ActionKey;
}

export interface ErrorBranch {
  readonly error: string;
  readonly to: ActionKey;
}

export interface FlowAction {
  readonly key: ActionKey;
  readonly type: ActionType;
  readonly parameters: { readonly [name: string]: Json };
  readonly next?: ActionKey;
  readonly conditions: readonly ConditionBranch[];
  readonly errors: readonly ErrorBranch[];
}

export interface Branches {
  readonly next: ActionKey;
  readonly error: ActionKey;
}

export type DataTableQuery = {
  readonly QueryName: string;
  readonly Attributes: readonly string[];
  readonly PrimaryValues: readonly { readonly AttributeName: string; readonly Value: string }[];
};

export type EventHooks =
  | { readonly DefaultAgentUI: string }
  | { readonly CustomerQueue: string };

export function equals(operand: string, to: ActionKey): ConditionBranch {
  return { operator: 'Equals', operands: [operand], to };
}

export function exists(to: ActionKey): ConditionBranch {
  return { operator: 'Exists', operands: [], to };
}

function onError(to: ActionKey): ErrorBranch[] {
  return [{ error: 'NoMatchingError', to }];
}

function simple(
  key: ActionKey,
  type: ActionType,
  parameters: FlowAction['parameters'],
  { next, error }: Branches,
): FlowAction {
  return { key, type, parameters, next, conditions: [], errors: onError(error) };
}

export function updateFlowLoggingBehavior(
  key: ActionKey,
  parameters: { readonly FlowLoggingBehavior: 'Enabled' | 'Disabled' },
  { next }: { readonly next: ActionKey },
): FlowAction {
  return { key, type: 'UpdateFlowLoggingBehavior', parameters, next, conditions: [], errors: [] };
}

export function updateContactTextToSpeechVoice(
  key: ActionKey,
  parameters: {
    readonly TextToSpeechVoice: string;
    readonly TextToSpeechEngine: 'Standard' | 'Neural' | 'Generative';
  },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactTextToSpeechVoice', parameters, branches);
}

export function evaluateDataTableValues(
  key: ActionKey,
  parameters: { readonly DataTableId: string; readonly Queries: readonly DataTableQuery[] },
  branches: Branches,
): FlowAction {
  return simple(key, 'EvaluateDataTableValues', parameters, branches);
}

export function messageParticipant(
  key: ActionKey,
  parameters: { readonly Text: string } | { readonly SSML: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'MessageParticipant', parameters, branches);
}

export function createWisdomSession(
  key: ActionKey,
  parameters: { readonly WisdomAssistantArn: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'CreateWisdomSession', parameters, branches);
}

export function invokeLambdaFunction(
  key: ActionKey,
  parameters: {
    readonly LambdaFunctionARN: string;
    readonly InvocationTimeLimitSeconds: string;
    readonly LambdaInvocationAttributes?: { readonly [name: string]: string };
  },
  branches: Branches,
): FlowAction {
  return simple(key, 'InvokeLambdaFunction', parameters, branches);
}

export function connectParticipantWithLexBot(
  key: ActionKey,
  parameters: {
    readonly Text: string;
    readonly LexV2Bot: { readonly AliasArn: string };
    readonly LexSessionAttributes?: { readonly [name: string]: string };
  },
  { next, timeout, noMatch, error }: {
    readonly next: ActionKey;
    readonly timeout: ActionKey;
    readonly noMatch: ActionKey;
    readonly error: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'ConnectParticipantWithLexBot',
    parameters,
    next,
    conditions: [],
    errors: [
      { error: 'InputTimeLimitExceeded', to: timeout },
      { error: 'NoMatchingCondition', to: noMatch },
      { error: 'NoMatchingError', to: error },
    ],
  };
}

export function compare(
  key: ActionKey,
  parameters: { readonly ComparisonValue: string },
  { next, conditions, noMatch }: {
    readonly next: ActionKey;
    readonly conditions: readonly [ConditionBranch, ...ConditionBranch[]];
    readonly noMatch: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'Compare',
    parameters,
    next,
    conditions,
    errors: [{ error: 'NoMatchingCondition', to: noMatch }],
  };
}

export function updateContactAttributes(
  key: ActionKey,
  parameters: {
    readonly Attributes: { readonly [name: string]: string };
    readonly TargetContact: 'Current' | 'Related';
  },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactAttributes', parameters, branches);
}

export function checkHoursOfOperation(
  key: ActionKey,
  parameters: { readonly HoursOfOperationId: string },
  { next, inHours, outOfHours, error }: {
    readonly next: ActionKey;
    readonly inHours: ActionKey;
    readonly outOfHours: ActionKey;
    readonly error: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'CheckHoursOfOperation',
    parameters,
    next,
    conditions: [equals('True', inHours), equals('False', outOfHours)],
    errors: onError(error),
  };
}

export function updateContactEventHooks(
  key: ActionKey,
  parameters: { readonly EventHooks: EventHooks },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactEventHooks', parameters, branches);
}

export function updateContactTargetQueue(
  key: ActionKey,
  parameters: { readonly QueueId: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactTargetQueue', parameters, branches);
}

export function transferContactToQueue(
  key: ActionKey,
  { next, atCapacity, error }: {
    readonly next: ActionKey;
    readonly atCapacity: ActionKey;
    readonly error: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'TransferContactToQueue',
    parameters: {},
    next,
    conditions: [],
    errors: [
      { error: 'QueueAtCapacity', to: atCapacity },
      { error: 'NoMatchingError', to: error },
    ],
  };
}

export function createCase(
  key: ActionKey,
  parameters: {
    readonly LinkContactToCase: 'true' | 'false';
    readonly CaseTemplateId: string;
    readonly CaseRequestFields: { readonly [fieldId: string]: string };
  },
  { next, notLinked, error }: {
    readonly next: ActionKey;
    readonly notLinked: ActionKey;
    readonly error: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'CreateCase',
    parameters,
    next,
    conditions: [],
    errors: [
      { error: 'ContactNotLinked', to: notLinked },
      { error: 'NoMatchingError', to: error },
    ],
  };
}

export function getCase(
  key: ActionKey,
  parameters: {
    readonly LinkContactToCase: 'true' | 'false';
    readonly GetLastUpdatedCase: 'true' | 'false';
    readonly CaseRequestFields: { readonly [fieldId: string]: string };
    readonly CaseResponseFields: readonly string[];
  },
  { next, error, noneFound, multipleFound }: {
    readonly next: ActionKey;
    readonly error: ActionKey;
    readonly noneFound: ActionKey;
    readonly multipleFound: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'GetCase',
    parameters,
    next,
    conditions: [],
    errors: [
      { error: 'NoMatchingError', to: error },
      { error: 'NoneFound', to: noneFound },
      { error: 'MultipleFound', to: multipleFound },
    ],
  };
}

export function wait(
  key: ActionKey,
  parameters: { readonly TimeLimitSeconds: string },
  { next, completed, error }: {
    readonly next: ActionKey;
    readonly completed: ActionKey;
    readonly error: ActionKey;
  },
): FlowAction {
  return {
    key,
    type: 'Wait',
    parameters,
    next,
    conditions: [equals('WaitCompleted', completed)],
    errors: onError(error),
  };
}

export function disconnectParticipant(key: ActionKey): FlowAction {
  return { key, type: 'DisconnectParticipant', parameters: {}, conditions: [], errors: [] };
}
