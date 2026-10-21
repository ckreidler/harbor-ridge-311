import { createHmac } from 'node:crypto';
import { chatHandler, stopVoiceHandler, touchpointRuntime, voiceHandler, type ProxyEvent } from '../lib/touchpoint-handler';

const ORIGIN = 'https://d111111abcdef8.cloudfront.net';

function request(body: unknown, origin: string | undefined = ORIGIN): ProxyEvent {
  return {
    headers: origin === undefined ? {} : { Origin: origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

const STOP_SECRET = 'test-stop-secret';
const CONTACT_ID = 'contact-1';

function stopToken(contactId = CONTACT_ID): string {
  return createHmac('sha256', STOP_SECRET).update(contactId).digest('base64url');
}

describe('touchpoint handlers', () => {
  const sent: Array<Record<string, unknown>> = [];
  let fail = false;
  let failureName = 'Error';

  beforeEach(() => {
    sent.length = 0;
    fail = false;
    failureName = 'Error';
    process.env.ALLOWED_ORIGIN = ORIGIN;
    process.env.INSTANCE_ID = 'instance-from-env';
    process.env.CONTACT_FLOW_ID = 'flow-from-env';
    process.env.STOP_SECRET = STOP_SECRET;
    touchpointRuntime.loadSdk = async <T>() => ({
      ConnectClient: class {
        send(command: { input: Record<string, unknown> }) {
          sent.push(command.input);
          if (fail) {
            const error = new Error('connect failed with account 123');
            error.name = failureName;
            throw error;
          }
          return {
            ContactId: 'contact-1',
            ParticipantId: 'participant-1',
            ParticipantToken: 'token-1',
            ConnectionData: { Meeting: { MeetingId: 'meeting-1' }, Attendee: { AttendeeId: 'attendee-1' } },
          };
        }
      },
      StartChatContactCommand: class {
        readonly input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
          this.input = input;
        }
      },
      StartWebRTCContactCommand: class {
        readonly input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
          this.input = input;
        }
      },
      StopContactCommand: class {
        readonly input: Record<string, unknown>;
        constructor(input: Record<string, unknown>) {
          this.input = input;
        }
      },
    } as T);
  });

  test('chat uses the server instance and flow and returns the sample envelope', async () => {
    const result = await chatHandler(request({
      InstanceId: 'browser-instance',
      ContactFlowId: 'browser-flow',
      Attributes: { injected: 'yes' },
      SupportedMessagingContentTypes: ['text/plain'],
    }));

    expect(result.statusCode).toBe(200);
    expect(result.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(sent).toEqual([{
      InstanceId: 'instance-from-env',
      ContactFlowId: 'flow-from-env',
      ParticipantDetails: { DisplayName: 'Harbor Ridge visitor' },
      SupportedMessagingContentTypes: [
        'text/plain',
        'text/markdown',
        'application/json',
        'application/vnd.amazonaws.connect.message.interactive',
        'application/vnd.amazonaws.connect.message.interactive.response',
      ],
    }]);
    expect(JSON.parse(result.body)).toEqual({
      data: {
        startChatResult: {
          ContactId: 'contact-1',
          ParticipantId: 'participant-1',
          ParticipantToken: 'token-1',
        },
        featurePermissions: { MESSAGING_MARKDOWN: true },
      },
    });
  });

  test('voice returns Chime connection data and does not enable video', async () => {
    const result = await voiceHandler(request({
      ConnectInstanceId: 'browser-instance',
      ContactFlowId: 'browser-flow',
      DisplayName: 'Browser',
    }));

    expect(result.statusCode).toBe(200);
    expect(sent[0]).toEqual({
      InstanceId: 'instance-from-env',
      ContactFlowId: 'flow-from-env',
      ParticipantDetails: { DisplayName: 'Harbor Ridge visitor' },
    });
    expect(sent[0]).not.toHaveProperty('AllowedCapabilities');
    expect(JSON.parse(result.body)).toEqual({
      ConnectionData: { Meeting: { MeetingId: 'meeting-1' }, Attendee: { AttendeeId: 'attendee-1' } },
      ContactId: 'contact-1',
      ParticipantId: 'participant-1',
      ParticipantToken: 'token-1',
      StopToken: stopToken(),
    });
  });

  test('voice does not start a contact when the stop secret is missing', async () => {
    delete process.env.STOP_SECRET;
    const result = await voiceHandler(request({}));

    expect(result.statusCode).toBe(502);
    expect(sent).toEqual([]);
  });

  test('chat does not require the stop secret and does not return a stop token', async () => {
    delete process.env.STOP_SECRET;
    const result = await chatHandler(request({}));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.startChatResult).not.toHaveProperty('StopToken');
  });

  test('rejects a different origin before calling Connect', async () => {
    const result = await chatHandler(request({}, 'https://example.com'));

    expect(result.statusCode).toBe(403);
    expect(result.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(sent).toEqual([]);
  });

  test('rejects a body that is not JSON', async () => {
    const result = await voiceHandler({
      headers: { origin: ORIGIN },
      body: '{',
    });

    expect(result.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  test('reads a base64 body and still uses the server instance', async () => {
    const result = await chatHandler({
      headers: { origin: ORIGIN },
      isBase64Encoded: true,
      body: Buffer.from(JSON.stringify({ InstanceId: 'nope' }), 'utf8').toString('base64'),
    });

    expect(result.statusCode).toBe(200);
    expect(sent[0].InstanceId).toBe('instance-from-env');
  });

  test('rejects a body larger than 4 KB', async () => {
    const result = await voiceHandler({
      headers: { origin: ORIGIN },
      body: JSON.stringify({ pad: 'x'.repeat(5000) }),
    });

    expect(result.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  test('hides Connect errors from the browser', async () => {
    fail = true;
    const result = await chatHandler(request({}));

    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain('123');
    expect(JSON.parse(result.body)).toEqual({ message: 'Could not start the contact' });
  });

  test('stops the contact this browser started and ignores a client instance id', async () => {
    const result = await stopVoiceHandler(request({
      ContactId: CONTACT_ID,
      StopToken: stopToken(),
      InstanceId: 'attacker-instance',
    }));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ stopped: true });
    expect(sent).toEqual([{
      InstanceId: 'instance-from-env',
      ContactId: CONTACT_ID,
    }]);
  });

  test('rejects a stop request that only has a contact id', async () => {
    const result = await stopVoiceHandler(request({ ContactId: CONTACT_ID }));

    expect(result.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  test('rejects a stop token issued for a different contact', async () => {
    const result = await stopVoiceHandler(request({
      ContactId: 'contact-2',
      StopToken: stopToken(CONTACT_ID),
    }));

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ message: 'Contact cannot be stopped' });
    expect(sent).toEqual([]);
  });

  test('rejects a stop token that was not issued for the contact', async () => {
    const result = await stopVoiceHandler(request({
      ContactId: CONTACT_ID,
      StopToken: 'not-the-token',
    }));

    expect(result.statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  test('rejects a stop contact id outside the issued alphabet', async () => {
    const result = await stopVoiceHandler(request({
      ContactId: '../other',
      StopToken: stopToken('../other'),
    }));

    expect(result.statusCode).toBe(403);
    expect(sent).toEqual([]);
  });

  test('rejects a stop request from a different origin before calling Connect', async () => {
    const result = await stopVoiceHandler(request({
      ContactId: CONTACT_ID,
      StopToken: stopToken(),
    }, 'https://example.com'));

    expect(result.statusCode).toBe(403);
    expect(result.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(sent).toEqual([]);
  });

  test('reads a base64 stop body', async () => {
    const result = await stopVoiceHandler({
      headers: { origin: ORIGIN },
      isBase64Encoded: true,
      body: Buffer.from(JSON.stringify({
        ContactId: CONTACT_ID,
        StopToken: stopToken(),
      }), 'utf8').toString('base64'),
    });

    expect(result.statusCode).toBe(200);
    expect(sent[0].ContactId).toBe(CONTACT_ID);
  });

  test('rejects a stop body that is not JSON', async () => {
    const result = await stopVoiceHandler({
      headers: { origin: ORIGIN },
      body: '{',
    });

    expect(result.statusCode).toBe(400);
    expect(sent).toEqual([]);
  });

  test('treats an already ended contact as stopped', async () => {
    fail = true;
    failureName = 'InvalidRequestException';
    const result = await stopVoiceHandler(request({
      ContactId: CONTACT_ID,
      StopToken: stopToken(),
    }));

    expect(result.statusCode).toBe(200);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(result.body)).toEqual({ stopped: true });
  });

  test('hides stop errors from the browser', async () => {
    fail = true;
    failureName = 'InternalServiceException';
    const result = await stopVoiceHandler(request({
      ContactId: CONTACT_ID,
      StopToken: stopToken(),
    }));

    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain('123');
    expect(JSON.parse(result.body)).toEqual({ message: 'Could not stop the contact' });
  });
});
