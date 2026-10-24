import {
  disconnectParticipant,
  flow,
  showView,
  type FlowContent,
  type InboundContactAction,
} from '../flow';

export interface EscalationGuideFlowProps {
  detailViewArn: string;
}

export const ESCALATION_GUIDE_FLOW_NAME = 'HarborRidge311-EscalationGuide';

const ESCALATION_FIELDS = [
  ['Reason', 'escalationReason'],
  ['Summary', 'escalationSummary'],
  ['Customer intent', 'customerIntent'],
  ['Sentiment', 'sentiment'],
] as const;

export function escalationGuideFlow(props: EscalationGuideFlowProps): FlowContent {
  const actions: readonly InboundContactAction[] = [
    showView('show-escalation', {
      ViewResource: { Id: props.detailViewArn },
      InvocationTimeLimitSeconds: '400',
      ViewData: {
        Heading: 'Harbor Ridge 311 escalation',
        AttributeBar: ESCALATION_FIELDS.map(([label, name]) => ({
          Label: label,
          Value: `$.Attributes.${name}`,
        })),
        Back: { Label: 'Close' },
      },
    }, {
      next: 'disconnect',
      error: 'disconnect',
      noMatch: 'disconnect',
      timeLimit: 'disconnect',
    }),
    disconnectParticipant('disconnect'),
  ];
  return flow({
    name: ESCALATION_GUIDE_FLOW_NAME,
    start: 'show-escalation',
    actions,
  });
}
