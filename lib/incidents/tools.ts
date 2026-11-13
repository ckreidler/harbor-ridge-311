export const INCIDENT_TARGET_NAME = 'Incidents';
export const INCIDENT_OPERATION = 'reportMajorIncident';
export const INCIDENT_API_STAGE = 'prod';

export function incidentPermission(): string {
  return `${INCIDENT_TARGET_NAME}___${INCIDENT_OPERATION}`;
}

export function incidentToolId(gatewayId: string): string {
  return `gateway_${gatewayId}__${incidentPermission()}`;
}
