import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { GogInputError, importGogEnvelope, parseGogInput } from '../src/gog-cli.js';

const receivedAt = '2026-07-06T10:05:00.000Z';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));

beforeAll(() => {
  execFileSync(process.execPath, [join(projectRoot, 'node_modules/typescript/bin/tsc')], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
});

function message(id: string, body: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    from: 'Discovery Bank <no-reply@discovery.bank>',
    internalDateIso: receivedAt,
    body,
    subject: 'Notification',
    ...overrides,
  };
}

function envelope(messages: unknown[], nextPageToken = '') {
  return { messages, nextPageToken };
}

const paymentBody =
  'Payment R 125.00 From Transaction Account Reference: Example ' +
  'Monday, 6 July at 12:00 Available balance: R 875.00';

describe('gog input contract', () => {
  it('accepts the documented envelope', () => {
    expect(parseGogInput(JSON.stringify(envelope([message('message-1', paymentBody)]))).messages).toHaveLength(1);
  });

  it('rejects malformed JSON and missing envelope fields', () => {
    expect(() => parseGogInput('{')).toThrowError(new GogInputError('stdin must contain valid JSON'));
    expect(() => importGogEnvelope({ nextPageToken: '' })).toThrow('messages must be an array');
    expect(() => importGogEnvelope({ messages: [] })).toThrow('nextPageToken must be a string');
  });

  it('rejects non-empty pagination tokens', () => {
    expect(() => importGogEnvelope(envelope([], 'next-page'))).toThrow('rerun gog with --all');
  });

  it('rejects missing required fields, empty IDs and invalid receipt dates', () => {
    expect(() => importGogEnvelope(envelope([{ id: 'message-1' }]))).toThrow('messages[0].from must be a string');
    expect(() => importGogEnvelope(envelope([message(' ', paymentBody)]))).toThrow('id must not be empty');
    expect(() => importGogEnvelope(envelope([message('message-1', paymentBody, { internalDateIso: '' })])))
      .toThrow('must be a valid ISO 8601 timestamp with a timezone');
    expect(() => importGogEnvelope(envelope([message('message-1', paymentBody, { internalDateIso: '2026-07-06' })])))
      .toThrow('must be a valid ISO 8601 timestamp with a timezone');
    expect(() => importGogEnvelope(envelope([message('message-1', paymentBody, { internalDateIso: '2026-02-30T12:00:00Z' })])))
      .toThrow('must be a valid ISO 8601 timestamp with a timezone');
  });

  it.skipIf(process.platform === 'win32')('runs the built CLI through a POSIX bin symlink', () => {
    const binDirectory = mkdtempSync(join(tmpdir(), 'discovery-bank-gog-bin-'));
    const binPath = join(binDirectory, 'discovery-bank-gog');
    try {
      symlinkSync(join(projectRoot, 'dist/gog-cli.js'), binPath);
      const invocation = spawnSync(binPath, [], {
        encoding: 'utf8',
        input: JSON.stringify(envelope([message('symlink-message', paymentBody)])),
      });
      expect(invocation.status).toBe(0);
      expect(invocation.stderr).toBe('');
      expect(JSON.parse(invocation.stdout).transactions[0]).toMatchObject({
        messageId: 'symlink-message',
        type: 'payment',
        amount: 125,
      });
    } finally {
      rmSync(binDirectory, { recursive: true, force: true });
    }
  });
});

describe('gog notification import', () => {
  it('deduplicates by ID only and preserves equal transactions with distinct IDs', () => {
    const result = importGogEnvelope(envelope([
      message('message-1', paymentBody),
      message('message-1', paymentBody),
      message('message-2', paymentBody),
    ]));
    expect(result.sourceMessageCount).toBe(3);
    expect(result.uniqueMessageCount).toBe(2);
    expect(result.transactions.map(transaction => transaction.messageId)).toEqual(['message-1', 'message-2']);
    expect(result.ignored).toContainEqual({ messageId: 'message-1', classification: 'duplicate-id' });
  });

  it('trusts the parsed mailbox and rejects an impostor substring', () => {
    const result = importGogEnvelope(envelope([
      message('trusted', paymentBody),
      message('impostor', paymentBody, { from: 'no-reply@discovery.bank.evil.example' }),
      message('display-impostor', paymentBody, { from: 'no-reply@discovery.bank <alerts@evil.example>' }),
    ]));
    expect(result.transactions).toHaveLength(1);
    expect(result.rejected).toEqual([
      { messageId: 'impostor', classification: 'untrusted-sender' },
      { messageId: 'display-impostor', classification: 'untrusted-sender' },
    ]);
  });

  it('counts declined cards and trusted nontransactions separately', () => {
    const result = importGogEnvelope(envelope([
      message('declined', 'Card payment declined for R 25.00'),
      message('notice', 'Your monthly account document is ready'),
    ]));
    expect(result.declinedCardMessageCount).toBe(1);
    expect(result.trustedNontransactionMessageCount).toBe(1);
    expect(result.transactions).toEqual([]);
    expect(result.coverageComplete).toBe(true);
  });

  it('ignores a parseable card purchase when a distant HTML notice says declined', () => {
    const separator = `<div>${'Additional merchant detail '.repeat(12)}</div>`;
    const result = importGogEnvelope(envelope([
      message(
        'long-declined',
        '<p>Card payment Example Store ZA – R 25.00 From Credit Card Card ending ***5678</p>' +
        `${separator}<strong>Declined</strong>` +
        '<p>Monday, 6 July at 12:00 Available balance: R 975.00</p>',
      ),
    ]));
    expect(result.transactions).toEqual([]);
    expect(result.declinedCardMessageCount).toBe(1);
    expect(result.ignored).toContainEqual({
      messageId: 'long-declined',
      classification: 'declined-card',
    });
  });

  it('marks unknown transactional formats as incomplete coverage', () => {
    const result = importGogEnvelope(envelope([
      message(
        'unknown',
        'New money event R 45.00 Monday, 6 July at 12:00 Available balance: R 955.00',
      ),
    ]));
    expect(result.coverage).toBe('notification-only');
    expect(result.coverageComplete).toBe(false);
    expect(result.unparsedTransactionalMessageCount).toBe(1);
    expect(result.rejected).toContainEqual({ messageId: 'unknown', classification: 'unparsed-transaction' });
    expect(result.errors[0]).toMatchObject({ messageId: 'unknown', code: 'unparsed-transaction' });
  });

  it('marks malformed transfers without balance markers as incomplete coverage', () => {
    const result = importGogEnvelope(envelope([
      message(
        'malformed-transfer',
        'Amount R 200.00 From Transaction Account To Demand Savings Monday, 6 July at 12:00',
        { subject: 'Transfer confirmation' },
      ),
    ]));
    expect(result.coverageComplete).toBe(false);
    expect(result.unparsedTransactionalMessageCount).toBe(1);
    expect(result.rejected).toContainEqual({
      messageId: 'malformed-transfer',
      classification: 'unparsed-transaction',
    });
  });

  it('keeps transfer marketing without an amount as trusted nontransaction mail', () => {
    const result = importGogEnvelope(envelope([
      message('marketing', 'Move money with less effort.', { subject: 'Transfer offers' }),
    ]));
    expect(result.coverageComplete).toBe(true);
    expect(result.trustedNontransactionMessageCount).toBe(1);
    expect(result.ignored).toContainEqual({
      messageId: 'marketing',
      classification: 'trusted-nontransaction',
    });
  });

  it('keeps card-payment reward marketing with an amount as trusted nontransaction mail', () => {
    const result = importGogEnvelope(envelope([
      message(
        'reward-marketing',
        'Earn R 100.00 when you make a card payment and explore more benefits.',
        { subject: 'Rewards' },
      ),
    ]));
    expect(result.coverageComplete).toBe(true);
    expect(result.trustedNontransactionMessageCount).toBe(1);
    expect(result.ignored).toContainEqual({
      messageId: 'reward-marketing',
      classification: 'trusted-nontransaction',
    });
  });

  it('keeps refunds as credit expenses and own-account transfers separate', () => {
    const refund =
      'Card payment reversal Example Store ZA – R 80.00 To Credit Card Card ending ***5678 ' +
      'Monday, 6 July at 12:00 Available balance: R 1,080.00';
    const transfer =
      'Transfer R 200.00 From Transaction Account To Demand Savings Monday, 6 July at 12:00';
    const result = importGogEnvelope(envelope([
      message('refund', refund),
      message('transfer', transfer),
    ]));
    expect(result.transactions[0]).toMatchObject({
      messageId: 'refund',
      type: 'card_reversal',
      direction: 'credit',
      amount: 80,
      flow: 'expense',
    });
    expect(result.transactions[1]).toMatchObject({
      messageId: 'transfer',
      type: 'transfer',
      direction: 'debit',
      amount: 200,
      flow: 'transfer',
    });
  });
});
