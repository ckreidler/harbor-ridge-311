import { agentVersionForChannel, handler, selectOrchestratorRuntime, type UpdateSessionCommandInput } from '../lib/select-orchestrator';

const SESSION_ARN = 'arn:aws:wisdom:us-west-2:945777367807:session/assistant/session';

function event(channel: string | undefined, sessionArn: string | undefined = SESSION_ARN) {
  return {
    Details: {
      ContactData: channel === undefined ? {} : { Channel: channel },
      Parameters: sessionArn === undefined ? {} : { sessionArn },
    },
  };
}

beforeEach(() => {
  process.env.ASSISTANT_ID = 'assistant-id';
  process.env.VOICE_AGENT_VERSION_ID = 'voice-version';
  process.env.CHAT_AGENT_VERSION_ID = 'chat-version';
});

test('agentVersionForChannel uses the chat agent only for chat contacts', () => {
  expect(agentVersionForChannel('CHAT')).toBe('chat-version');
  expect(agentVersionForChannel('VOICE')).toBe('voice-version');
  expect(agentVersionForChannel(undefined)).toBe('voice-version');
});

test('handler updates the session orchestrator for the contact channel', async () => {
  const updates: UpdateSessionCommandInput[] = [];
  const updateSession = selectOrchestratorRuntime.updateSession;
  selectOrchestratorRuntime.updateSession = async (input) => {
    updates.push(input);
  };
  try {
    await expect(handler(event('CHAT'))).resolves.toEqual({ channel: 'CHAT' });
    await expect(handler(event('VOICE'))).resolves.toEqual({ channel: 'VOICE' });
  } finally {
    selectOrchestratorRuntime.updateSession = updateSession;
  }
  expect(updates).toEqual([
    {
      assistantId: 'assistant-id',
      sessionId: SESSION_ARN,
      orchestratorConfigurationList: [{
        aiAgentId: 'chat-version',
        orchestratorUseCase: 'Connect.SelfService',
      }],
    },
    {
      assistantId: 'assistant-id',
      sessionId: SESSION_ARN,
      orchestratorConfigurationList: [{
        aiAgentId: 'voice-version',
        orchestratorUseCase: 'Connect.SelfService',
      }],
    },
  ]);
});

test('handler rejects a contact that has no session ARN', async () => {
  await expect(handler({
    Details: {
      ContactData: { Channel: 'VOICE' },
      Parameters: {},
    },
  })).rejects.toThrow('Missing session ARN');
});
