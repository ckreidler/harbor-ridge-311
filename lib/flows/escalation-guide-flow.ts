type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

interface FlowError {
  ErrorType: string;
  NextAction: string;
}

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters: { [key: string]: Json };
  Transitions: {
    NextAction?: string;
    Errors?: FlowError[];
    Conditions?: [];
  };
}

interface ContactFlowContent {
  Version: '2019-10-30';
  StartAction: string;
  Metadata: {
    entryPointPosition: { x: number; y: number };
    ActionMetadata: Record<string, { position: { x: number; y: number } }>;
  };
  Actions: FlowAction[];
}

export interface EscalationGuideFlowProps {
  detailViewArn: string;
}

const ESCALATION_FIELDS = [
  ['Reason', 'escalationReason'],
  ['Summary', 'escalationSummary'],
  ['Customer intent', 'customerIntent'],
  ['Sentiment', 'sentiment'],
] as const;

function errorTo(nextAction: string): FlowError[] {
  return [
    { ErrorType: 'NoMatchingError', NextAction: nextAction },
    { ErrorType: 'NoMatchingCondition', NextAction: nextAction },
    { ErrorType: 'TimeLimitExceeded', NextAction: nextAction },
  ];
}

export function escalationGuideFlow(props: EscalationGuideFlowProps): ContactFlowContent {
  return {
    Version: '2019-10-30',
    StartAction: 'show-escalation',
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata: {
        'show-escalation': { position: { x: 160, y: 40 } },
        disconnect: { position: { x: 440, y: 40 } },
      },
    },
    Actions: [
      {
        Identifier: 'show-escalation',
        Type: 'ShowView',
        Parameters: {
          ViewResource: {
            Id: props.detailViewArn,
          },
          InvocationTimeLimitSeconds: '400',
          ViewData: {
            Heading: 'Harbor Ridge 311 escalation',
            AttributeBar: ESCALATION_FIELDS.map(([label, name]) => ({
              Label: label,
              Value: `$.Attributes.${name}`,
            })),
            Back: { Label: 'Close' },
          },
        },
        Transitions: {
          NextAction: 'disconnect',
          Errors: errorTo('disconnect'),
          Conditions: [],
        },
      },
      {
        Identifier: 'disconnect',
        Type: 'DisconnectParticipant',
        Parameters: {},
        Transitions: {},
      },
    ],
  };
}
