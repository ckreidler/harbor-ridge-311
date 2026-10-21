import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createContext, runInContext } from 'node:vm';

const launchSource = readFileSync(path.join(__dirname, '../website/launch.js'), 'utf8');

const config = {
  chatEndpoint: 'https://api.example/prod/chat',
  voiceEndpoint: 'https://api.example/prod/voice',
  voiceStopEndpoint: 'https://api.example/prod/voice/stop',
};

interface FetchInit {
  method?: string;
  body?: string;
  keepalive?: boolean;
  headers?: Record<string, string>;
}

interface JsonBody {
  ContactId?: string;
  StopToken?: string;
}

function jsonResponse(status: number, body: JsonBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return jsonResponse(status, body);
    },
    json: async () => body,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function load(sendBeacon: () => boolean = () => true) {
  const listeners: Record<string, Array<() => void>> = {};
  const clicks: Record<string, Array<() => void>> = {};
  const beacons: Array<{ url: string; body: string }> = [];
  const fetches: Array<{ url: string; init?: FetchInit }> = [];
  let nextVoice: { status: number; body: JsonBody } = {
    status: 200,
    body: { ContactId: 'contact-1', StopToken: 'issued-token' },
  };
  const page = {
    HARBOR_RIDGE_TOUCHPOINT: { ...config },
    fetch(input: unknown, init?: FetchInit) {
      const url = typeof input === 'string' ? input : String((input as { url?: string } | null)?.url ?? '');
      fetches.push({ url, init });
      if (url === config.voiceEndpoint) return Promise.resolve(jsonResponse(nextVoice.status, nextVoice.body));
      if (url === config.chatEndpoint) {
        return Promise.resolve(jsonResponse(200, { ContactId: 'chat-contact', StopToken: 'chat-token' }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    },
    addEventListener(type: string, handler: () => void) {
      (listeners[type] ??= []).push(handler);
    },
  };
  const sandbox = {
    console,
    window: page,
    document: {
      getElementById(id: string) {
        if (id === 'contact-status') return { hidden: true, textContent: '' };
        if (id === 'start-chat' || id === 'start-call') {
          return {
            disabled: false,
            setAttribute() {},
            addEventListener(type: string, handler: () => void) {
              if (type === 'click') (clicks[id] ??= []).push(handler);
            },
          };
        }
        return null;
      },
    },
    navigator: {
      sendBeacon(url: string, body: string) {
        const queued = sendBeacon();
        if (queued) beacons.push({ url, body });
        return queued;
      },
    },
  };
  runInContext(launchSource, createContext(sandbox));
  return {
    page,
    clicks,
    beacons,
    fetches,
    answerVoice(body: JsonBody, status = 200) {
      nextVoice = { status, body };
    },
    async start(url = config.voiceEndpoint) {
      await page.fetch(url, { method: 'POST', body: '{}' });
      await flush();
    },
    leave() {
      for (const handler of listeners.pagehide ?? []) handler();
    },
  };
}

describe('voice tab close', () => {
  test('beacons the issued stop token when the page is left during a call', async () => {
    const page = load();
    page.answerVoice({ ContactId: 'contact-1', StopToken: 'issued-token' });
    await page.start();

    expect(page.beacons).toEqual([]);
    page.leave();

    expect(page.beacons).toEqual([{
      url: config.voiceStopEndpoint,
      body: JSON.stringify({ ContactId: 'contact-1', StopToken: 'issued-token' }),
    }]);
    page.leave();
    expect(page.beacons).toHaveLength(1);
  });

  test('keeps the latest voice contact and ignores chat responses', async () => {
    const page = load();
    page.answerVoice({ ContactId: 'contact-1', StopToken: 'token-1' });
    await page.start();
    page.answerVoice({ ContactId: 'contact-2', StopToken: 'token-2' });
    await page.start();
    await page.start(config.chatEndpoint);
    page.leave();

    expect(page.beacons).toEqual([{
      url: config.voiceStopEndpoint,
      body: JSON.stringify({ ContactId: 'contact-2', StopToken: 'token-2' }),
    }]);
  });

  test('does not beacon when the voice call never started', async () => {
    const page = load();
    page.answerVoice({ ContactId: 'contact-1', StopToken: 'issued-token' }, 502);
    await page.start();
    page.clicks['start-call']?.[0]?.();
    page.leave();

    expect(page.beacons).toEqual([]);
    expect(page.fetches.some((call) => call.url === config.voiceStopEndpoint)).toBe(false);
  });

  test('uses a keepalive fetch when the beacon cannot be queued', async () => {
    const page = load(() => false);
    page.answerVoice({ ContactId: 'contact-1', StopToken: 'issued-token' });
    await page.start();
    page.leave();

    expect(page.beacons).toEqual([]);
    const stop = page.fetches.filter((call) => call.url === config.voiceStopEndpoint);
    expect(stop).toEqual([{
      url: config.voiceStopEndpoint,
      init: {
        method: 'POST',
        body: JSON.stringify({ ContactId: 'contact-1', StopToken: 'issued-token' }),
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      },
    }]);
    page.leave();
    expect(page.fetches.filter((call) => call.url === config.voiceStopEndpoint)).toHaveLength(1);
  });
});
