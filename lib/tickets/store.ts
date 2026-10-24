import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { TicketError, storedTicket, type Ticket } from './model';

export interface TicketStore {
  putNew(ticket: Ticket): Promise<boolean>;
  get(ticketId: string): Promise<Ticket | undefined>;
  queryByCustomer(customerId: string, limit: number): Promise<Ticket[]>;
  save(ticket: Ticket): Promise<void>;
}

function conditionalFailure(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'ConditionalCheckFailedException';
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
        Item: ticket,
        ConditionExpression: 'attribute_not_exists(ticketId)',
      }));
      return true;
    } catch (error) {
      if (conditionalFailure(error)) return false;
      throw error;
    }
  }

  async get(ticketId: string): Promise<Ticket | undefined> {
    const result = await this.document.send(new GetCommand({
      TableName: this.tableName,
      Key: { ticketId },
    }));
    return result.Item === undefined ? undefined : storedTicket(result.Item);
  }

  async queryByCustomer(customerId: string, limit: number): Promise<Ticket[]> {
    const result = await this.document.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: 'ByCustomer',
      KeyConditionExpression: 'customerId = :customerId',
      ExpressionAttributeValues: { ':customerId': customerId },
      ScanIndexForward: false,
      Limit: limit,
    }));
    return (result.Items ?? []).map((item) => storedTicket(item));
  }

  async save(ticket: Ticket): Promise<void> {
    try {
      await this.document.send(new PutCommand({
        TableName: this.tableName,
        Item: ticket,
        ConditionExpression: 'customerId = :customerId',
        ExpressionAttributeValues: { ':customerId': ticket.customerId },
      }));
    } catch (error) {
      if (conditionalFailure(error)) throw new TicketError(404, 'Ticket was not found');
      throw error;
    }
  }
}
