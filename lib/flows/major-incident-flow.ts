import {
  CONTACT_FLOW,
  CUSTOMER_QUEUE,
  disconnectParticipant,
  flow,
  transferContactToQueue,
  updateContactEventHooks,
  updateContactTargetQueue,
  wait,
  type CompiledFlow,
} from '../flow';

export interface MajorIncidentFlowProps {
  queueArn: string;
  customerQueueFlowArn: string;
}

export const MAJOR_INCIDENT_FLOW_NAME = 'HarborRidge311-MajorIncident';
export const MAJOR_INCIDENT_QUEUE_FLOW_NAME = 'HarborRidge311-MajorIncidentQueue';

const QUEUE_WAIT_SECONDS = '180';

export function majorIncidentQueueFlow(): CompiledFlow<typeof CUSTOMER_QUEUE> {
  return flow({
    name: MAJOR_INCIDENT_QUEUE_FLOW_NAME,
    type: CUSTOMER_QUEUE,
    start: 'wait-for-supervisor',
    actions: [
      wait('wait-for-supervisor', {
        TimeLimitSeconds: QUEUE_WAIT_SECONDS,
      }, {
        next: 'wait-for-supervisor',
        completed: 'wait-for-supervisor',
        error: 'wait-for-supervisor',
      }),
    ],
  });
}

export function majorIncidentFlow(props: MajorIncidentFlowProps): CompiledFlow<typeof CONTACT_FLOW> {
  return flow({
    name: MAJOR_INCIDENT_FLOW_NAME,
    type: CONTACT_FLOW,
    start: 'set-working-queue',
    actions: [
      updateContactTargetQueue('set-working-queue', {
        QueueId: props.queueArn,
      }, { next: 'set-customer-queue', error: 'disconnect' }),
      updateContactEventHooks('set-customer-queue', {
        EventHooks: { CustomerQueue: props.customerQueueFlowArn },
      }, { next: 'transfer-to-queue', error: 'disconnect' }),
      transferContactToQueue('transfer-to-queue', {
        next: 'disconnect',
        atCapacity: 'disconnect',
        error: 'disconnect',
      }),
      disconnectParticipant('disconnect'),
    ],
  });
}
