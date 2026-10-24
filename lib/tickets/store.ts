import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TicketError, storedTicket, type Ticket } from './model';

export interface StoredTicket extends Ticket {
  readonly version: number;
}

export interface TicketStore {
  putNew(ticket: Ticket): Promise<boolean>;
  get(ticketId: string): Promise<StoredTicket | undefined>;
  queryByCustomer(customerId: string, limit: number): Promise<StoredTicket[]>;
  save(expected: StoredTicket, ticket: Ticket): Promise<void>;
}

function conditionalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ConditionalCheckFailedException';
}

function withVersion(value: unknown): StoredTicket {
  const ticket = storedTicket(value);
  if (typeof value !== 'object' || value === null || !('version' in value)) {
    throw new Error('stored ticket version is invalid');
  }
  const version = value.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new Error('stored ticket version is invalid');
  }
  return { ...ticket, version };
}

export class DynamoTicketStore implements TicketStore {
  private readonly document = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  constructor(private readonly tableName: string) {}

  async putNew(ticket: Ticket): Promise<boolean> {
    try {
      await this.document.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...ticket, version: 1 },
        ConditionExpression: 'attribute_not_exists(ticketId)',
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async get(ticketId: string): Promise<StoredTicket | undefined> {
    const result = await this.document.send(new GetCommand({
      TableName: this.tableName,
      Key: { ticketId },
    }));
    return result.Item === undefined ? undefined : withVersion(result.Item);
  }

  async queryByCustomer(customerId: string, limit: number): Promise<StoredTicket[]> {
    const result = await this.document.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'ByCustomer',
      KeyConditionExpression: 'customerId = :customerId',
      ExpressionAttributeValues: { ':customerId': customerId },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (result.Items ?? []).map((item) => withVersion(item));
  }

  async save(expected: StoredTicket, ticket: Ticket): Promise<void> {
    try {
      await this.document.send(new PutCommand({
        TableName: this.tableName,
        Item: { ...ticket, version: expected.version + 1 },
        ConditionExpression: 'customerId = :customerId AND version = :version',
        ExpressionAttributeValues: {
          ':customerId': expected.customerId,
          ':version': expected.version,
        },
      }));
    } catch (error) {
      if (!conditionalFailure(error)) throw error;
      const current = await this.get(ticket.ticketId);
      if (!current || current.customerId !== ticket.customerId) {
        throw new TicketError(404, 'Ticket was not found');
      }
      throw new TicketError(409, 'The ticket changed');
    }
  }
}
