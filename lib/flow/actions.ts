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
  readonly to: string;
}

export interface ErrorBranch {
  readonly error: string;
  readonly to: string;
}

export interface ContinuingAction {
  readonly key: string;
  readonly type: Exclude<ActionType, 'DisconnectParticipant'>;
  readonly parameters: { readonly [name: string]: Json };
  readonly next: string;
  readonly conditions: readonly ConditionBranch[];
  readonly errors: readonly ErrorBranch[];
}

export interface TerminalAction {
  readonly key: string;
  readonly type: 'DisconnectParticipant';
  readonly parameters: { readonly [name: string]: Json };
}

export type FlowAction = ContinuingAction | TerminalAction;

export interface Branches {
  readonly next: string;
  readonly error: string;
}

export type DataTableQuery = {
  readonly QueryName: string;
  readonly Attributes: readonly string[];
  readonly PrimaryValues: readonly { readonly AttributeName: string; readonly Value: string }[];
};

export type EventHooks =
  | { readonly DefaultAgentUI: string }
  | { readonly CustomerQueue: string };

export function equals(operand: string, to: string): ConditionBranch {
  return { operator: 'Equals', operands: [operand], to };
}

export function exists(to: string): ConditionBranch {
  return { operator: 'Exists', operands: [], to };
}

function onError(to: string): ErrorBranch[] {
  return [{ error: 'NoMatchingError', to }];
}

function simple(
  key: string,
  type: Exclude<ActionType, 'DisconnectParticipant'>,
  parameters: ContinuingAction['parameters'],
  { next, error }: Branches,
): ContinuingAction {
  return { key, type, parameters, next, conditions: [], errors: onError(error) };
}

export function updateFlowLoggingBehavior(
  key: string,
  parameters: { readonly FlowLoggingBehavior: 'Enabled' | 'Disabled' },
  { next }: { readonly next: string },
): FlowAction {
  return { key, type: 'UpdateFlowLoggingBehavior', parameters, next, conditions: [], errors: [] };
}

export function updateContactTextToSpeechVoice(
  key: string,
  parameters: {
    readonly TextToSpeechVoice: string;
    readonly TextToSpeechEngine: 'Standard' | 'Neural' | 'Generative';
  },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactTextToSpeechVoice', parameters, branches);
}

export function evaluateDataTableValues(
  key: string,
  parameters: { readonly DataTableId: string; readonly Queries: readonly DataTableQuery[] },
  branches: Branches,
): FlowAction {
  return simple(key, 'EvaluateDataTableValues', parameters, branches);
}

export function messageParticipant(
  key: string,
  parameters: { readonly Text: string } | { readonly SSML: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'MessageParticipant', parameters, branches);
}

export function createWisdomSession(
  key: string,
  parameters: { readonly WisdomAssistantArn: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'CreateWisdomSession', parameters, branches);
}

export function invokeLambdaFunction(
  key: string,
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
  key: string,
  parameters: {
    readonly Text: string;
    readonly LexV2Bot: { readonly AliasArn: string };
    readonly LexSessionAttributes?: { readonly [name: string]: string };
  },
  { next, timeout, noMatch, error }: {
    readonly next: string;
    readonly timeout: string;
    readonly noMatch: string;
    readonly error: string;
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
  key: string,
  parameters: { readonly ComparisonValue: string },
  { next, conditions, noMatch }: {
    readonly next: string;
    readonly conditions: readonly [ConditionBranch, ...ConditionBranch[]];
    readonly noMatch: string;
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
  key: string,
  parameters: {
    readonly Attributes: { readonly [name: string]: string };
    readonly TargetContact: 'Current' | 'Related';
  },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactAttributes', parameters, branches);
}

export function checkHoursOfOperation(
  key: string,
  parameters: { readonly HoursOfOperationId: string },
  { next, inHours, outOfHours, error }: {
    readonly next: string;
    readonly inHours: string;
    readonly outOfHours: string;
    readonly error: string;
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
  key: string,
  parameters: { readonly EventHooks: EventHooks },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactEventHooks', parameters, branches);
}

export function updateContactTargetQueue(
  key: string,
  parameters: { readonly QueueId: string },
  branches: Branches,
): FlowAction {
  return simple(key, 'UpdateContactTargetQueue', parameters, branches);
}

export function transferContactToQueue(
  key: string,
  { next, atCapacity, error }: {
    readonly next: string;
    readonly atCapacity: string;
    readonly error: string;
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
  key: string,
  parameters: {
    readonly LinkContactToCase: 'true' | 'false';
    readonly CaseTemplateId: string;
    readonly CaseRequestFields: { readonly [fieldId: string]: string };
  },
  { next, notLinked, error }: {
    readonly next: string;
    readonly notLinked: string;
    readonly error: string;
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
  key: string,
  parameters: {
    readonly LinkContactToCase: 'true' | 'false';
    readonly GetLastUpdatedCase: 'true' | 'false';
    readonly CaseRequestFields: { readonly [fieldId: string]: string };
    readonly CaseResponseFields: readonly string[];
  },
  { next, error, noneFound, multipleFound }: {
    readonly next: string;
    readonly error: string;
    readonly noneFound: string;
    readonly multipleFound: string;
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
  key: string,
  parameters: { readonly TimeLimitSeconds: string },
  { next, completed, error }: {
    readonly next: string;
    readonly completed: string;
    readonly error: string;
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

export function disconnectParticipant(key: string): TerminalAction {
  return { key, type: 'DisconnectParticipant', parameters: {} };
}
