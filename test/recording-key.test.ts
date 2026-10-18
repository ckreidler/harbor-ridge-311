import { contactIdFromRecordingKey, wavDurationSeconds } from '../lib/voicemail-handler';
import { RECORDINGS_PREFIX, VOICEMAIL_RECORDING_KEY_PATTERN } from '../lib/connect-stack';

const CONTACT_ID = '11111111-2222-4333-8444-555555555555';

test('contactIdFromRecordingKey reads the contact id before the first underscore', () => {
  const key = `${RECORDINGS_PREFIX}/ivr/2026/10/18/${CONTACT_ID}_20261018T18:44_UTC.wav`;
  expect(contactIdFromRecordingKey(key)).toBe(CONTACT_ID);
});

test('contactIdFromRecordingKey decodes a URL-encoded key before parsing', () => {
  const key = `${RECORDINGS_PREFIX}/ivr/2026/10/18/${CONTACT_ID}_20261018T18%3A44_UTC.wav`;
  expect(contactIdFromRecordingKey(key)).toBe(CONTACT_ID);
});

test('contactIdFromRecordingKey rejects a basename that is not a UUID', () => {
  const key = `${RECORDINGS_PREFIX}/ivr/2026/10/18/not-a-contact_20261018T18:44_UTC.wav`;
  expect(contactIdFromRecordingKey(key)).toBeUndefined();
});

test('voicemail object key pattern is the recordings prefix plus the IVR wildcard', () => {
  expect(VOICEMAIL_RECORDING_KEY_PATTERN).toBe(`${RECORDINGS_PREFIX}*ivr/*.wav`);
  expect(VOICEMAIL_RECORDING_KEY_PATTERN).toBe('call-recordings/*ivr/*.wav');
});

test('wavDurationSeconds uses (size - data offset) / byteRate', () => {
  const objectSize = 253_484;
  const header = Buffer.alloc(64);
  header.write('RIFF', 0);
  header.writeUInt32LE(objectSize - 8, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(objectSize - 44, 40);

  expect(wavDurationSeconds(header, objectSize)).toBe((objectSize - 44) / 32_000);
  expect(wavDurationSeconds(header, objectSize)).toBe(7.92);
});
