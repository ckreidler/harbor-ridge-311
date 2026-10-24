import {
  CONTACT_FLOW,
  disconnectParticipant,
  flow,
  showView,
  type CompiledFlow,
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

export function escalationGuideFlow(props: EscalationGuideFlowProps): CompiledFlow<typeof CONTACT_FLOW> {
  return flow({
    name: ESCALATION_GUIDE_FLOW_NAME,
    type: CONTACT_FLOW,
    start: 'show-escalation',
    actions: [
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
    ],
  });
}
