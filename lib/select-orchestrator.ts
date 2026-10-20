export const SELF_SERVICE_USE_CASE = 'Connect.SelfService';

interface QConnectModule {
  QConnectClient: new (config?: { region?: string }) => {
    send(command: unknown): Promise<unknown>;
  };
  UpdateSessionCommand: new (input: UpdateSessionInput) => unknown;
}

export interface UpdateSessionInput {
  assistantId: string;
  sessionId: string;
  orchestratorConfigurationList: Array<{
    aiAgentId: string;
    orchestratorUseCase: string;
  }>;
}

export interface SelectOrchestratorEvent {
  Details?: {
    ContactData?: { Channel?: string };
    Parameters?: { sessionArn?: string };
  };
}

export const selectOrchestratorRuntime = {
  loadSdk<T>(specifier: string): Promise<T> {
    return import(specifier) as Promise<T>;
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
  const { QConnectClient, UpdateSessionCommand } = await selectOrchestratorRuntime.loadSdk<QConnectModule>(
    '@aws-sdk/client-qconnect',
  );
  const client = new QConnectClient({});
  const input: UpdateSessionInput = {
    assistantId,
    sessionId: sessionArn,
    orchestratorConfigurationList: [{
      aiAgentId: agentVersionForChannel(channel),
      orchestratorUseCase: SELF_SERVICE_USE_CASE,
    }],
  };
  await client.send(new UpdateSessionCommand(input));
  return { channel };
}
