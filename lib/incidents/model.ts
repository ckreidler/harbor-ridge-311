export const LIMITS = {
  issue: 500,
  impact: 2000,
  id: 64,
  phone: 64,
  email: 254,
  nameIssue: 80,
} as const;

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const CHANNELS = ['VOICE', 'CHAT'] as const;

export type IncidentChannel = (typeof CHANNELS)[number];

export class IncidentError extends Error {
  constructor(readonly status: 400, message: string) {
    super(message);
  }
}

export interface MajorIncident {
  readonly issue: string;
  readonly impact: string;
  readonly impactedCount: number;
  readonly channel: IncidentChannel;
  readonly contactId: string;
  readonly profileId?: string;
  readonly phone?: string;
  readonly email?: string;
}

export interface IncidentDispatch {
  readonly name: string;
  readonly description: string;
  readonly attributes: Record<string, string>;
}

function isChannel(value: string): value is IncidentChannel {
  return CHANNELS.some((channel) => channel === value);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new IncidentError(400, `${field} is invalid`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || trimmed.includes('\u0000')) {
    throw new IncidentError(400, `${field} is invalid`);
  }
  return trimmed;
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return text(value, field, max);
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new IncidentError(400, `${field} is invalid`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredId(value, field);
}

export function incidentTaskName(issue: string): string {
  const short = issue.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, LIMITS.nameIssue);
  return `Major incident: ${short}`;
}

export function incidentSummary(report: MajorIncident): string {
  const lines = [
    'Major incident',
    `Issue: ${report.issue}`,
    `Impact: ${report.impact}`,
    `People impacted: ${report.impactedCount}`,
    `Channel: ${report.channel}`,
    `Contact: ${report.contactId}`,
  ];
  if (report.profileId) lines.push(`Profile: ${report.profileId}`);
  if (report.phone) lines.push(`Phone: ${report.phone}`);
  if (report.email) lines.push(`Email: ${report.email}`);
  return lines.join('\n');
}

export function incidentAttributes(report: MajorIncident): Record<string, string> {
  const attributes: Record<string, string> = {
    issue: report.issue,
    impact: report.impact,
    impactedCount: String(report.impactedCount),
    channel: report.channel,
    contactId: report.contactId,
  };
  if (report.profileId) attributes.profileId = report.profileId;
  if (report.phone) attributes.phone = report.phone;
  if (report.email) attributes.email = report.email;
  return attributes;
}

export function incidentDispatch(report: MajorIncident): IncidentDispatch {
  return {
    name: incidentTaskName(report.issue),
    description: incidentSummary(report),
    attributes: incidentAttributes(report),
  };
}

export function parseReport(value: Record<string, unknown>): MajorIncident {
  const allowed = new Set([
    'issue', 'impact', 'impactedCount', 'channel', 'contactId', 'instanceId', 'profileId', 'phone', 'email',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new IncidentError(400, 'Unexpected field');
  }
  if (typeof value.channel !== 'string' || !isChannel(value.channel)) {
    throw new IncidentError(400, 'channel is invalid');
  }
  const impactedCount = value.impactedCount;
  if (typeof impactedCount !== 'number' || !Number.isSafeInteger(impactedCount) || impactedCount < 1) {
    throw new IncidentError(400, 'impactedCount is invalid');
  }
  const profileId = optionalId(value.profileId, 'profileId');
  const phone = optionalText(value.phone, 'phone', LIMITS.phone);
  const email = optionalText(value.email, 'email', LIMITS.email);
  return {
    issue: text(value.issue, 'issue', LIMITS.issue),
    impact: text(value.impact, 'impact', LIMITS.impact),
    impactedCount,
    channel: value.channel,
    contactId: requiredId(value.contactId, 'contactId'),
    ...(profileId ? { profileId } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
  };
}
