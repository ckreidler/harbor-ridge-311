export const RECORDING_ATTEMPTS = 5;
export const RECORDING_DELAY_MS = 20_000;

export async function findRecordingKey(
  listKeys: (prefix: string) => Promise<string[]>,
  prefix: string,
  contactId: string,
  sleep: (ms: number) => Promise<void>,
  attempts = RECORDING_ATTEMPTS,
  delayMs = RECORDING_DELAY_MS,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const match = (await listKeys(prefix)).find((key) => key.includes(contactId));
    if (match) {
      return match;
    }
    if (attempt < attempts - 1) {
      await sleep(delayMs);
    }
  }
  throw new Error(`No recording found for contact ${contactId}`);
}
