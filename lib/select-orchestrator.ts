import {
  QConnectClient,
  SessionDataNamespace,
  UpdateSessionCommand,
  UpdateSessionDataCommand,
  type UpdateSessionCommandInput,
  type UpdateSessionDataCommandInput,
} from '@aws-sdk/client-qconnect';

export const SELF_SERVICE_USE_CASE = 'Connect.SelfService';

export type { UpdateSessionCommandInput };

export interface SelectOrchestratorEvent {
  Details?: {
    ContactData?: { Channel?: string };
    Parameters?: { sessionArn?: string; customerId?: string };
  };
}

export const selectOrchestratorRuntime = {
  async updateSession(input: UpdateSessionCommandInput): Promise<void> {
    const client = new QConnectClient({});
    await client.send(new UpdateSessionCommand(input));
  },
  async updateSessionData(input: UpdateSessionDataCommandInput): Promise<void> {
    const client = new QConnectClient({});
    await client.send(new UpdateSessionDataCommand(input));
  },
};

export function agentVersionForChannel(channel: string | undefined): string {
  if (channel === 'CHAT') {
    const chatAgentVersionId = process.env.CHAT_AGENT_VERSION_ID;
    if (!chatAgentVersionId) {
      throw new Error('Missing CHAT_AGENT_VERSION_ID');
    }
    return chatAgentVersionId;
  }
  const voiceAgentVersionId = process.env.VOICE_AGENT_VERSION_ID;
  if (!voiceAgentVersionId) {
    throw new Error('Missing VOICE_AGENT_VERSION_ID');
  }
  return voiceAgentVersionId;
}

export async function handler(event: SelectOrchestratorEvent): Promise<{ channel: string }> {
  const channel = event.Details?.ContactData?.Channel ?? 'VOICE';
  const sessionArn = event.Details?.Parameters?.sessionArn;
  const assistantId = process.env.ASSISTANT_ID;
  if (!sessionArn) {
    throw new Error('Missing session ARN');
  }
  if (!assistantId) {
    throw new Error('Missing ASSISTANT_ID');
  }
  await selectOrchestratorRuntime.updateSession({
    assistantId,
    sessionId: sessionArn,
    orchestratorConfigurationList: [{
      aiAgentId: agentVersionForChannel(channel),
      orchestratorUseCase: SELF_SERVICE_USE_CASE,
    }],
  });
  const customerId = event.Details?.Parameters?.customerId;
  if (customerId) {
    await selectOrchestratorRuntime.updateSessionData({
      assistantId,
      sessionId: sessionArn,
      namespace: SessionDataNamespace.Custom,
      data: [{ key: 'customerId', value: { stringValue: customerId } }],
    });
  }
  return { channel };
}
