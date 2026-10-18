import { afterHoursFlow } from '../lib/flows/after-hours-flow';
import { mainFlow } from '../lib/flows/main-flow';

const allowedErrors: Record<string, readonly string[]> = {
  UpdateFlowLoggingBehavior: [],
  CheckHoursOfOperation: ['NoMatchingError'],
  TransferToFlow: ['NoMatchingError'],
  GetParticipantInput: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  UpdateContactData: ['NoMatchingError'],
  UpdateContactTextToSpeechVoice: ['NoMatchingError'],
  EvaluateDataTableValues: ['NoMatchingError'],
  MessageParticipant: ['NoMatchingError'],
  CreateWisdomSession: ['NoMatchingError'],
  Compare: ['NoMatchingCondition'],
  ConnectParticipantWithLexBot: ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError'],
  DisconnectParticipant: [],
  UpdateContactAttributes: ['NoMatchingError'],
  UpdateContactRecordingBehavior: [],
};

test('flow actions only use error branches their action type allows', () => {
  const flows = [
    mainFlow({
      dataTableId: 'table',
      wisdomAssistantArn: 'assistant',
      lexBotAliasArn: 'alias',
      hoursOfOperationArn: 'hours',
      afterHoursFlowArn: 'after-hours',
    }),
    afterHoursFlow(),
  ];

  for (const flow of flows) {
    const identifiers = new Set(flow.Actions.map((action) => action.Identifier));
    expect(identifiers.has(flow.StartAction)).toBe(true);
    for (const action of flow.Actions) {
      const allowed = allowedErrors[action.Type];
      expect(allowed).toBeDefined();
      const used = (action.Transitions.Errors ?? []).map((error) => error.ErrorType);
      expect(used.every((errorType) => allowed.includes(errorType))).toBe(true);
      if (action.Type !== 'DisconnectParticipant') {
        expect(action.Transitions.NextAction).toEqual(expect.any(String));
        expect(identifiers.has(action.Transitions.NextAction ?? '')).toBe(true);
      }
      for (const error of action.Transitions.Errors ?? []) {
        expect(identifiers.has(error.NextAction)).toBe(true);
      }
      for (const branch of action.Transitions.Conditions ?? []) {
        expect(identifiers.has(branch.NextAction)).toBe(true);
      }
    }
  }

  const recording = afterHoursFlow().Actions.find((action) => action.Type === 'UpdateContactRecordingBehavior');
  expect(recording?.Transitions).toEqual({
    NextAction: 'leave-message',
    Errors: [],
    Conditions: [],
  });
});
