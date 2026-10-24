export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export type ActionType =
  | 'UpdateFlowLoggingBehavior'
  | 'UpdateContactTextToSpeechVoice'
  | 'EvaluateDataTableValues'
  | 'MessageParticipant'
  | 'MessageParticipantIteratively'
  | 'CreateWisdomSession'
  | 'InvokeLambdaFunction'
  | 'ConnectParticipantWithLexBot'
  | 'Compare'
  | 'UpdateContactAttributes'
  | 'CheckHoursOfOperation'
  | 'UpdateContactEventHooks'
  | 'UpdateContactTargetQueue'
  | 'TransferContactToQueue'
  | 'GetCustomerProfile'
  | 'CreateCustomerProfile'
  | 'Wait'
  | 'ShowView'
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

type Action<T extends Exclude<ActionType, 'DisconnectParticipant'>> =
  ContinuingAction & { readonly type: T };

export type FlowAction =
  | { [T in Exclude<ActionType, 'DisconnectParticipant'>]: Action<T> }[Exclude<ActionType, 'DisconnectParticipant'>]
  | TerminalAction;

export type CustomerQueueActionType =
  | 'Compare'
  | 'EvaluateDataTableValues'
  | 'MessageParticipant'
  | 'MessageParticipantIteratively'
  | 'Wait';

export type CustomerQueueAction = Extract<FlowAction, { readonly type: CustomerQueueActionType }>;

export type InboundContactAction = Exclude<FlowAction, { readonly type: 'MessageParticipantIteratively' }>;

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

function simple<T extends Exclude<ActionType, 'DisconnectParticipant'>>(
  key: string,
  type: T,
  parameters: ContinuingAction['parameters'],
  { next, error }: Branches,
): Action<T> {
  return { key, type, parameters, next, conditions: [], errors: onError(error) };
}

export function updateFlowLoggingBehavior(
  key: string,
  parameters: { readonly FlowLoggingBehavior: 'Enabled' | 'Disabled' },
  { next }: { readonly next: string },
): Action<'UpdateFlowLoggingBehavior'> {
  return { key, type: 'UpdateFlowLoggingBehavior', parameters, next, conditions: [], errors: [] };
}

export function updateContactTextToSpeechVoice(
  key: string,
  parameters: {
    readonly TextToSpeechVoice: string;
    readonly TextToSpeechEngine: 'Standard' | 'Neural' | 'Generative';
  },
  branches: Branches,
): Action<'UpdateContactTextToSpeechVoice'> {
  return simple(key, 'UpdateContactTextToSpeechVoice', parameters, branches);
}

export function evaluateDataTableValues(
  key: string,
  parameters: { readonly DataTableId: string; readonly Queries: readonly DataTableQuery[] },
  branches: Branches,
): Action<'EvaluateDataTableValues'> {
  return simple(key, 'EvaluateDataTableValues', parameters, branches);
}

export function messageParticipant(
  key: string,
  parameters: { readonly Text: string } | { readonly SSML: string },
  branches: Branches,
): Action<'MessageParticipant'> {
  return simple(key, 'MessageParticipant', parameters, branches);
}

export function createWisdomSession(
  key: string,
  parameters: { readonly WisdomAssistantArn: string },
  branches: Branches,
): Action<'CreateWisdomSession'> {
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
): Action<'InvokeLambdaFunction'> {
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
): Action<'ConnectParticipantWithLexBot'> {
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
): Action<'Compare'> {
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
): Action<'UpdateContactAttributes'> {
  for (const [name, value] of Object.entries(parameters.Attributes)) {
    if (value.length === 0) {
      throw new Error(`UpdateContactAttributes "${key}" attribute "${name}" is empty`);
    }
  }
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
): Action<'CheckHoursOfOperation'> {
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
): Action<'UpdateContactEventHooks'> {
  return simple(key, 'UpdateContactEventHooks', parameters, branches);
}

export function updateContactTargetQueue(
  key: string,
  parameters: { readonly QueueId: string },
  branches: Branches,
): Action<'UpdateContactTargetQueue'> {
  return simple(key, 'UpdateContactTargetQueue', parameters, branches);
}

export function transferContactToQueue(
  key: string,
  { next, atCapacity, error }: {
    readonly next: string;
    readonly atCapacity: string;
    readonly error: string;
  },
): Action<'TransferContactToQueue'> {
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

export function getCustomerProfile(
  key: string,
  parameters: {
    readonly ProfileRequestData: {
      readonly IdentifierName: string;
      readonly IdentifierValue: string;
    };
    readonly ProfileResponseData: readonly string[];
  },
  { next, error, noneFound, multipleFound }: {
    readonly next: string;
    readonly error: string;
    readonly noneFound: string;
    readonly multipleFound: string;
  },
): Action<'GetCustomerProfile'> {
  return {
    key,
    type: 'GetCustomerProfile',
    parameters,
    next,
    conditions: [],
    errors: [
      { error: 'NoMatchingError', to: error },
      { error: 'NoneFoundError', to: noneFound },
      { error: 'MultipleFoundError', to: multipleFound },
    ],
  };
}

export function createCustomerProfile(
  key: string,
  parameters: {
    readonly ProfileRequestData: { readonly [field: string]: string };
  },
  { next, error }: {
    readonly next: string;
    readonly error: string;
  },
): Action<'CreateCustomerProfile'> {
  return {
    key,
    type: 'CreateCustomerProfile',
    parameters,
    next,
    conditions: [],
    errors: [{ error: 'NoMatchingError', to: error }],
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
): Action<'Wait'> {
  return {
    key,
    type: 'Wait',
    parameters,
    next,
    conditions: [equals('WaitCompleted', completed)],
    errors: onError(error),
  };
}

export type IterativeMessage =
  | { readonly Text: string }
  | { readonly SSML: string }
  | { readonly PromptId: string };

export function messageParticipantIteratively(
  key: string,
  parameters: { readonly Messages: readonly IterativeMessage[] },
  { next }: { readonly next: string },
): Action<'MessageParticipantIteratively'> {
  return {
    key,
    type: 'MessageParticipantIteratively',
    parameters,
    next,
    conditions: [],
    errors: [],
  };
}

export function showView(
  key: string,
  parameters: {
    readonly ViewResource: { readonly Id: string };
    readonly InvocationTimeLimitSeconds: string;
    readonly ViewData: {
      readonly Heading: string;
      readonly AttributeBar: readonly { readonly Label: string; readonly Value: string }[];
      readonly Back: { readonly Label: string };
    };
  },
  { next, error, noMatch, timeLimit }: {
    readonly next: string;
    readonly error: string;
    readonly noMatch: string;
    readonly timeLimit: string;
  },
): Action<'ShowView'> {
  return {
    key,
    type: 'ShowView',
    parameters,
    next,
    conditions: [],
    errors: [
      { error: 'NoMatchingError', to: error },
      { error: 'NoMatchingCondition', to: noMatch },
      { error: 'TimeLimitExceeded', to: timeLimit },
    ],
  };
}

export function disconnectParticipant(key: string): TerminalAction {
  return { key, type: 'DisconnectParticipant', parameters: {} };
}
