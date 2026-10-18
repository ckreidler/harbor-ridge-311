import { findRecordingKey } from '../lib/find-recording';

test('findRecordingKey polls until the contact recording appears', async () => {
  const seen: string[] = [];
  let calls = 0;
  const key = await findRecordingKey(
    async (prefix) => {
      calls += 1;
      seen.push(prefix);
      if (calls < 3) {
        return [`${prefix}2026/10/18/other-contact_UTC.wav`];
      }
      return [`${prefix}2026/10/18/contact-1_UTC.wav`];
    },
    'call-recordings/',
    'contact-1',
    async () => undefined,
    5,
    0,
  );
  expect(key).toBe('call-recordings/2026/10/18/contact-1_UTC.wav');
  expect(calls).toBe(3);
  expect(seen).toEqual(['call-recordings/', 'call-recordings/', 'call-recordings/']);
});

test('findRecordingKey throws when the recording never arrives', async () => {
  await expect(findRecordingKey(
    async () => [],
    'call-recordings/',
    'contact-1',
    async () => undefined,
    2,
    0,
  )).rejects.toThrow('No recording found for contact contact-1');
});