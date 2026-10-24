import {
  CONTACT_FLOW,
  checkHoursOfOperation,
  compare,
  connectParticipantWithLexBot,
  createCustomerProfile,
  createWisdomSession,
  disconnectParticipant,
  equals,
  evaluateDataTableValues,
  exists,
  flow,
  getCustomerProfile,
  invokeLambdaFunction,
  messageParticipant,
  transferContactToQueue,
  updateContactAttributes,
  updateContactEventHooks,
  updateContactTargetQueue,
  updateContactTextToSpeechVoice,
  updateFlowLoggingBehavior,
  type CompiledFlow,
  type DataTableQuery,
} from '../flow';

export interface MainFlowProps {
  dataTableId: string;
  wisdomAssistantArn: string;
  lexBotAliasArn: string;
  orchestratorLambdaArn: string;
  hoursOfOperationArn: string;
  queueArn: string;
  escalationGuideFlowArn: string;
  customerQueueFlowArn: string;
  ticketLambdaArn: string;
}

export const MAIN_FLOW_NAME = 'HarborRidge311-Main';

const VOICE_GREETING = 'Thank you for calling Harbor Ridge 3 1 1. This line is a demo.';
const VOICE_GOODBYE = 'Thank you for calling Harbor Ridge 3 1 1. Goodbye.';

export const AFTER_HOURS_TICKET_CHAT_TEXT = "Harbor Ridge 311 is closed right now, so we've logged your request. Your request number is";
export const AFTER_HOURS_TICKET_VOICE_TEXT = 'Harbor Ridge 3 1 1 is closed right now, so we have logged your request. Your request number is';
export const AFTER_HOURS_TICKET_TEXT_AFTER = 'Our team works Monday to Friday, 8 a.m. to 5 p.m. Pacific and will follow up then.';
export const AFTER_HOURS_CLOSED_TEXT = 'Harbor Ridge 311 is closed right now. Our team is available Monday to Friday, 8 a.m. to 5 p.m. Pacific.';
const TICKET_ID_ATTRIBUTE = '$.External.ticketId';
const AFTER_HOURS_TICKET_PLAY_TEXT = `$.DataTables.AfterHoursTicket.Text ${TICKET_ID_ATTRIBUTE}. $.DataTables.AfterHoursTicket.TextAfter`;
const AFTER_HOURS_TICKET_VOICE_SSML = `<speak>$.DataTables.AfterHoursTicket.Text <say-as interpret-as="characters">${TICKET_ID_ATTRIBUTE}</say-as>. $.DataTables.AfterHoursTicket.TextAfter</speak>`;
const FALLBACK_TICKET_SUBJECT = 'After-hours request';

function promptQuery(
  prompt: 'Greeting' | 'Goodbye' | 'Question' | 'AfterHoursTicket',
  attributes: string[] = ['Text'],
): DataTableQuery {
  return {
    QueryName: prompt,
    Attributes: attributes,
    PrimaryValues: [
      { AttributeName: 'Prompt', Value: prompt },
      { AttributeName: 'Channel', Value: '$.Channel' },
    ],
  };
}

function profileLookup(
  key: string,
  identifierName: string,
  identifierValue: string,
  found: string,
  missing: string,
  skip: string,
) {
  return getCustomerProfile(key, {
    ProfileRequestData: {
      IdentifierName: identifierName,
      IdentifierValue: identifierValue,
    },
    ProfileResponseData: [],
  }, {
    next: found,
    error: skip,
    noneFound: missing,
    multipleFound: skip,
  });
}

export function mainFlow(props: MainFlowProps): CompiledFlow {
  return flow({
    name: MAIN_FLOW_NAME,
    type: CONTACT_FLOW,
    start: 'enable-flow-logging',
    actions: [
      updateFlowLoggingBehavior('enable-flow-logging', {
        FlowLoggingBehavior: 'Enabled',
      }, { next: 'set-en-voice' }),
      updateContactTextToSpeechVoice('set-en-voice', {
        TextToSpeechVoice: 'Joanna',
        TextToSpeechEngine: 'Neural',
      }, { next: 'lookup-prompts', error: 'lookup-prompts' }),
      evaluateDataTableValues('lookup-prompts', {
        DataTableId: props.dataTableId,
        Queries: [
          promptQuery('Greeting'),
          promptQuery('Goodbye'),
          promptQuery('Question'),
        ],
      }, { next: 'play-greeting', error: 'play-fallback' }),
      messageParticipant('play-greeting', {
        Text: '$.DataTables.Greeting.Text',
      }, { next: 'branch-identity', error: 'play-fallback' }),
      compare('branch-identity', {
        ComparisonValue: '$.Channel',
      }, {
        next: 'check-caller-phone',
        conditions: [equals('CHAT', 'check-chat-email')],
        noMatch: 'check-caller-phone',
      }),
      compare('check-chat-email', {
        ComparisonValue: '$.Attributes.email',
      }, {
        next: 'create-assistant-session',
        conditions: [exists('find-profile-email')],
        noMatch: 'create-assistant-session',
      }),
      compare('check-caller-phone', {
        ComparisonValue: '$.CustomerEndpoint.Address',
      }, {
        next: 'create-assistant-session',
        conditions: [exists('find-profile-phone')],
        noMatch: 'create-assistant-session',
      }),
      profileLookup(
        'find-profile-phone',
        '_phone',
        '$.CustomerEndpoint.Address',
        'set-customer-id',
        'create-profile-phone',
        'create-assistant-session',
      ),
      profileLookup(
        'find-profile-email',
        '_email',
        '$.Attributes.email',
        'set-customer-id',
        'create-profile-email',
        'create-assistant-session',
      ),
      createCustomerProfile('create-profile-phone', {
        ProfileRequestData: {
          PhoneNumber: '$.CustomerEndpoint.Address',
          FirstName: 'Resident',
        },
      }, { next: 'set-customer-id', error: 'create-assistant-session' }),
      createCustomerProfile('create-profile-email', {
        ProfileRequestData: {
          EmailAddress: '$.Attributes.email',
          FirstName: 'Resident',
        },
      }, { next: 'set-customer-id', error: 'create-assistant-session' }),
      updateContactAttributes('set-customer-id', {
        Attributes: { customerId: '$.Customer.ProfileId' },
        TargetContact: 'Current',
      }, { next: 'create-assistant-session', error: 'create-assistant-session' }),
      createWisdomSession('create-assistant-session', {
        WisdomAssistantArn: props.wisdomAssistantArn,
      }, { next: 'select-orchestrator', error: 'play-goodbye' }),
      invokeLambdaFunction('select-orchestrator', {
        LambdaFunctionARN: props.orchestratorLambdaArn,
        InvocationTimeLimitSeconds: '8',
        LambdaInvocationAttributes: {
          sessionArn: '$.Wisdom.SessionArn',
          customerId: '$.Attributes.customerId',
        },
      }, { next: 'ask-en-question', error: 'ask-en-question' }),
      connectParticipantWithLexBot('ask-en-question', {
        Text: '$.DataTables.Question.Text',
        LexV2Bot: {
          AliasArn: props.lexBotAliasArn,
        },
        LexSessionAttributes: {
          'x-amz-lex:q-in-connect:session-arn': '$.Wisdom.SessionArn',
        },
      }, {
        next: 'check-hours',
        timeout: 'check-hours',
        noMatch: 'check-tool',
        error: 'check-hours',
      }),
      compare('check-tool', {
        ComparisonValue: '$.Lex.SessionAttributes.Tool',
      }, {
        next: 'play-goodbye',
        conditions: [
          equals('Complete', 'play-goodbye'),
          equals('Escalate', 'set-escalation'),
        ],
        noMatch: 'check-hours',
      }),
      updateContactAttributes('set-escalation', {
        Attributes: {
          escalationReason: '$.Lex.SessionAttributes.escalationReason',
          escalationSummary: '$.Lex.SessionAttributes.escalationSummary',
          customerIntent: '$.Lex.SessionAttributes.customerIntent',
          sentiment: '$.Lex.SessionAttributes.sentiment',
        },
        TargetContact: 'Current',
      }, { next: 'check-hours', error: 'check-hours' }),
      checkHoursOfOperation('check-hours', {
        HoursOfOperationId: props.hoursOfOperationArn,
      }, {
        next: 'set-event-flow',
        inHours: 'set-event-flow',
        outOfHours: 'check-ticket-subject',
        error: 'check-ticket-subject',
      }),
      updateContactEventHooks('set-event-flow', {
        EventHooks: {
          DefaultAgentUI: props.escalationGuideFlowArn,
        },
      }, { next: 'set-working-queue', error: 'play-goodbye' }),
      updateContactTargetQueue('set-working-queue', {
        QueueId: props.queueArn,
      }, { next: 'set-customer-queue', error: 'play-goodbye' }),
      updateContactEventHooks('set-customer-queue', {
        EventHooks: {
          CustomerQueue: props.customerQueueFlowArn,
        },
      }, { next: 'transfer-to-queue', error: 'transfer-to-queue' }),
      transferContactToQueue('transfer-to-queue', {
        next: 'play-goodbye',
        atCapacity: 'play-goodbye',
        error: 'play-goodbye',
      }),
      compare('check-ticket-subject', {
        ComparisonValue: '$.Attributes.customerIntent',
      }, {
        next: 'set-fallback-subject',
        conditions: [exists('set-ticket-subject')],
        noMatch: 'set-fallback-subject',
      }),
      updateContactAttributes('set-ticket-subject', {
        Attributes: { ticketSubject: '$.Attributes.customerIntent' },
        TargetContact: 'Current',
      }, { next: 'check-customer-id', error: 'set-fallback-subject' }),
      updateContactAttributes('set-fallback-subject', {
        Attributes: { ticketSubject: FALLBACK_TICKET_SUBJECT },
        TargetContact: 'Current',
      }, { next: 'check-customer-id', error: 'play-closed' }),
      compare('check-customer-id', {
        ComparisonValue: '$.Attributes.customerId',
      }, {
        next: 'play-closed',
        conditions: [exists('create-ticket')],
        noMatch: 'play-closed',
      }),
      invokeLambdaFunction('create-ticket', {
        LambdaFunctionARN: props.ticketLambdaArn,
        InvocationTimeLimitSeconds: '8',
      }, { next: 'check-ticket-id', error: 'play-closed' }),
      compare('check-ticket-id', {
        ComparisonValue: TICKET_ID_ATTRIBUTE,
      }, {
        next: 'play-closed',
        conditions: [exists('lookup-after-hours-ticket')],
        noMatch: 'play-closed',
      }),
      evaluateDataTableValues('lookup-after-hours-ticket', {
        DataTableId: props.dataTableId,
        Queries: [promptQuery('AfterHoursTicket', ['Text', 'TextAfter'])],
      }, { next: 'check-ticket-prompt', error: 'play-closed' }),
      compare('check-ticket-prompt', {
        ComparisonValue: '$.DataTables.AfterHoursTicket.Text',
      }, {
        next: 'play-closed',
        conditions: [exists('branch-ticket-channel')],
        noMatch: 'play-closed',
      }),
      compare('branch-ticket-channel', {
        ComparisonValue: '$.Channel',
      }, {
        next: 'play-ticket-voice',
        conditions: [equals('CHAT', 'play-ticket-chat')],
        noMatch: 'play-ticket-voice',
      }),
      messageParticipant('play-ticket-chat', {
        Text: AFTER_HOURS_TICKET_PLAY_TEXT,
      }, { next: 'disconnect', error: 'play-closed' }),
      messageParticipant('play-ticket-voice', {
        SSML: AFTER_HOURS_TICKET_VOICE_SSML,
      }, { next: 'disconnect', error: 'play-closed' }),
      messageParticipant('play-closed', {
        Text: AFTER_HOURS_CLOSED_TEXT,
      }, { next: 'disconnect', error: 'disconnect' }),
      messageParticipant('play-goodbye', {
        Text: '$.DataTables.Goodbye.Text',
      }, { next: 'disconnect', error: 'disconnect' }),
      messageParticipant('play-fallback', {
        Text: `${VOICE_GREETING} ${VOICE_GOODBYE}`,
      }, { next: 'disconnect', error: 'disconnect' }),
      disconnectParticipant('disconnect'),
    ],
  });
}
