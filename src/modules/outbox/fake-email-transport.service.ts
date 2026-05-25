import { Injectable } from '@nestjs/common';

export interface SentEmail {
  to: string;
  subject: string;
  body: string;
  sentAt: string;
}

@Injectable()
export class FakeEmailTransport {
  private readonly sent: SentEmail[] = [];

  send(email: Omit<SentEmail, 'sentAt'>): SentEmail {
    const record: SentEmail = { ...email, sentAt: new Date().toISOString() };
    this.sent.push(record);
    return record;
  }

  list(): readonly SentEmail[] {
    return this.sent;
  }

  reset(): void {
    this.sent.length = 0;
  }
}
