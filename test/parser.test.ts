import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseEmail,
  deriveFlow,
  looksTransactional,
  normalizeEmailText,
  DEFAULT_ACCOUNT_NAMES,
} from '../src/parser.js';

// Fixtures are synthetic but format-faithful copies of Discovery Bank
// notification text — no real names, balances or card numbers. If Discovery
// changes a format, fix the parser first, then update the fixture to match the
// new real format.

// parseEmail infers the year relative to receipt, so pin "now" relative to the
// fixture dates.
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00+02:00'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('card payments', () => {
  it('parses a local (ZAR) card payment', () => {
    const tx = parseEmail(
      'Dear Customer, Card payment Temu.com Dublin IE – R 388.00 From Credit Card ' +
      'Card ending ***1234 Thursday, 16 July at 08:29 Available balance: R 98067.39 ' +
      'For more info, call 0800 07 96 97'
    );
    expect(tx).toMatchObject({
      type: 'card_payment',
      direction: 'debit',
      amount: 388,
      description: 'Temu.com Dublin IE',
      fromAccountRaw: 'account ending ***1234',
      cardEndingRaw: '***1234',
      balanceAfter: 98067.39,
      transactedAt: '2026-07-16T08:29:00.000+02:00',
    });
    expect(tx?.toAccountRaw).toBeUndefined();
  });

  it('parses amounts and balances containing thousands separators', () => {
    const tx = parseEmail(
      'Card payment WOOLWORTHS BLUE BIRD ZA – R 1,259.45 From Credit Card ' +
      'Card ending ***1234 Sunday, 12 July at 11:32 Available balance: R 101,567.80'
    );
    expect(tx?.amount).toBe(1259.45);
    expect(tx?.balanceAfter).toBe(101567.8);
  });

  it('parses a card payment reversal as a credit to the card', () => {
    const tx = parseEmail(
      'Card payment reversal Takealot Cape Town ZA – R 250.00 To Credit Card ' +
      'Card ending ***1234 Wednesday, 15 July at 09:57 Available balance: R 98705.39'
    );
    expect(tx).toMatchObject({
      type: 'card_reversal',
      direction: 'credit',
      amount: 250,
      description: 'Takealot Cape Town ZA',
      toAccountRaw: 'account ending ***1234',
    });
    expect(tx?.fromAccountRaw).toBeUndefined();
  });

  it('parses a foreign-currency card payment with unknown ZAR amount', () => {
    const tx = parseEmail(
      'Card payment AWS EMEA aws.amazon.com LU – USD 12.34 From Credit Card ' +
      'Card ending ***1234 Tuesday, 14 July at 03:12'
    );
    expect(tx).toMatchObject({
      type: 'card_payment',
      amount: 0,
      foreignAmount: 12.34,
      foreignCurrency: 'USD',
      description: 'AWS EMEA aws.amazon.com LU',
    });
  });

  it('returns null when the merchant/amount line is missing', () => {
    expect(parseEmail('Card payment declined on your Credit Card')).toBeNull();
  });

  // Discovery labels card refunds "Cash deposit" and writes "Card ending:"
  // with a colon, unlike the payment emails.
  it('parses a "Cash deposit" card refund as a reversal', () => {
    const tx = parseEmail(
      '--> Important notice Cash deposit East Midlands Railway Der – GBP 17.20 ' +
      'To Credit Card Card ending: ***1234 Thursday, 16 July at 08:29 ' +
      'Available balance: R79,392.86 For more info, call 0800 07 96 97'
    );
    expect(tx).toMatchObject({
      type: 'card_reversal',
      direction: 'credit',
      amount: 0,
      foreignAmount: 17.2,
      foreignCurrency: 'GBP',
      description: 'East Midlands Railway Der',
      toAccountRaw: 'account ending ***1234',
      balanceAfter: 79392.86,
    });
    expect(tx!.fromAccountRaw).toBeUndefined();
    expect(deriveFlow(tx!.type, tx!.direction)).toBe('expense');
  });

  // "Cash deposit" without the card-payment shape is a different event and
  // must not be forced into a reversal.
  it('returns null for a cash deposit with no card line', () => {
    expect(parseEmail(
      'Cash deposit R 500.00 To Transaction Account Thursday, 16 July at 08:29'
    )).toBeNull();
  });
});

describe('other transaction types', () => {
  it('parses a debit order with the reference as description', () => {
    const tx = parseEmail(
      'Dear Customer, Debit order R 1,120.00 From Transaction Account ' +
      'Reference: DISCOVERY LIFE Monday, 6 July at 06:15 Available balance: R 5,000.00'
    );
    expect(tx).toMatchObject({
      type: 'debit_order',
      direction: 'debit',
      amount: 1120,
      description: 'DISCOVERY LIFE',
      fromAccountRaw: 'Transaction Account',
      balanceAfter: 5000,
    });
  });

  it('parses an incoming payment as a credit', () => {
    const tx = parseEmail(
      'Incoming payment R 10,000.00 To Transaction Account Reference: SALARY ' +
      'Friday, 10 July at 08:00 Available balance: R 15,000.00'
    );
    expect(tx).toMatchObject({
      type: 'incoming_payment',
      direction: 'credit',
      amount: 10000,
      description: 'SALARY',
      toAccountRaw: 'Transaction Account',
    });
  });

  it('parses a real-time payment received as a credit', () => {
    const tx = parseEmail(
      'Real-time payment received R 456.78 To account ending ***1234 Reference: Example ' +
      'Wednesday, 7 October at 10:51 Available balance: R 456.78'
    );
    expect(tx).toMatchObject({
      type: 'incoming_payment',
      direction: 'credit',
      amount: 456.78,
      description: 'Example',
      toAccountRaw: 'account ending ***1234',
      transactedAt: '2025-10-07T10:51:00.000+02:00',
    });
  });

  it('rejects an incoming payment whose amount is missing instead of using its balance', () => {
    const tx = parseEmail(
      'Incoming payment To Transaction Account Reference: SALARY ' +
      'Friday, 10 July at 08:00 Available balance: R 15,000.00'
    );
    expect(tx).toBeNull();
  });

  it('parses an outgoing payment', () => {
    const tx = parseEmail(
      'Payment R 2,500.00 From Transaction Account Reference: RENT JULY ' +
      'Wednesday, 1 July at 09:00 Available balance: R 3,000.00'
    );
    expect(tx).toMatchObject({
      type: 'payment',
      direction: 'debit',
      amount: 2500,
      description: 'RENT JULY',
      fromAccountRaw: 'Transaction Account',
    });
  });

  // Discovery Pay is labelled "Discovery Pay", not "Payment", and uniquely
  // names the payee.
  it('parses a Discovery Pay, preferring the payee over the reference', () => {
    const tx = parseEmail(
      '--> Important notice Discovery Pay R 2.50 To Bob Smith ' +
      'From account ending ***5678 Reference: lunch money ' +
      'Wednesday, 1 July at 09:00 Available balance: R 4,875.60'
    );
    expect(tx).toMatchObject({
      type: 'payment',
      direction: 'debit',
      amount: 2.5,
      description: 'Bob Smith',
      fromAccountRaw: 'account ending ***5678',
      balanceAfter: 4875.6,
    });
    expect(deriveFlow(tx!.type, tx!.direction)).toBe('expense');
  });

  it('parses a Discovery Pay with no reference line', () => {
    const tx = parseEmail(
      'Discovery Pay R 150.00 To Bob Smith From account ending ***5678 ' +
      'Wednesday, 1 July at 09:00 Available balance: R 4,000.00'
    );
    expect(tx).toMatchObject({ type: 'payment', amount: 150, description: 'Bob Smith' });
  });

  it('still uses the reference for a plain payment, which names no payee', () => {
    const tx = parseEmail(
      'Payment R 300.00 From Demand Savings Reference: Parking ' +
      'Wednesday, 1 July at 09:00 Available balance: R 111,115.96'
    );
    expect(tx).toMatchObject({ type: 'payment', amount: 300, description: 'Parking' });
  });

  it('parses a transfer between own accounts', () => {
    const tx = parseEmail(
      'Transfer R 3,000.00 From Transaction Account To Demand Savings Monday, 6 July at 12:00'
    );
    expect(tx).toMatchObject({
      type: 'transfer',
      direction: 'debit',
      amount: 3000,
      fromAccountRaw: 'Transaction Account',
      toAccountRaw: 'Demand Savings',
    });
  });

  it('parses a forex transfer with exchange rate', () => {
    const tx = parseEmail(
      'Forex transfer R 3,296.84 to £ 149.04 From Transaction Account To GBP Account ' +
      'Exchange Rate 1 GBP = 22.12 ZAR Thursday, 9 July at 10:00'
    );
    expect(tx).toMatchObject({
      type: 'forex_transfer',
      direction: 'debit',
      amount: 3296.84,
      foreignAmount: 149.04,
      foreignCurrency: 'GBP',
      exchangeRate: 22.12,
      fromAccountRaw: 'Transaction Account',
      toAccountRaw: 'GBP Account',
    });
  });

  it('parses an ATM withdrawal with a hyphen-minus amount separator', () => {
    const tx = parseEmail(
      'ATM withdrawal At OR Tambo Branch Kempton P - R 990.00 From Transaction Account ' +
      'Saturday, 4 July at 14:30 Available balance: R 2,000.00'
    );
    expect(tx).toMatchObject({
      type: 'atm_withdrawal',
      direction: 'debit',
      amount: 990,
      description: 'At OR Tambo Branch Kempton P',
      fromAccountRaw: 'Transaction Account',
    });
  });

  it('returns null for non-transaction emails', () => {
    expect(parseEmail('Dear Customer, your one-time PIN is 123456')).toBeNull();
  });
});

describe('date handling', () => {
  it('assumes last year for a date that would land in the future', () => {
    // Email about 31 December processed on 1 January
    vi.setSystemTime(new Date('2026-01-01T10:00:00+02:00'));
    const tx = parseEmail(
      'Card payment Test Merchant – R 100.00 From Credit Card Card ending ***1234 ' +
      'Wednesday, 31 December at 23:59'
    );
    expect(tx?.transactedAt).toBe('2025-12-31T23:59:00.000+02:00');
  });

  it('uses the SAST year just after local midnight', () => {
    vi.setSystemTime(new Date('2026-01-01T00:30:00+02:00'));
    const tx = parseEmail(
      'Card payment Test Merchant – R 100.00 From Credit Card Card ending ***1234 ' +
      'Thursday, 1 January at 00:15'
    );
    expect(tx?.transactedAt).toBe('2026-01-01T00:15:00.000+02:00');
  });

  it('rejects a transaction when its date is missing', () => {
    const tx = parseEmail('Card payment Test Merchant – R 100.00 From Credit Card Card ending ***1234');
    expect(tx).toBeNull();
  });

  it('anchors year inference to original receipt time when reparsed later', () => {
    const tx = parseEmail(
      'Incoming payment R 1,000.00 To Transaction Account Reference: OLD PAYMENT ' +
      'Monday, 30 June at 08:00 Available balance: R 5,000.00',
      '2025-06-30T06:05:00.000Z',
    );
    expect(tx?.transactedAt).toBe('2025-06-30T08:00:00.000+02:00');
  });

  it('accepts receivedAt as an options object or a bare Date', () => {
    const body =
      'Incoming payment R 1,000.00 To Transaction Account Reference: OLD PAYMENT ' +
      'Monday, 30 June at 08:00 Available balance: R 5,000.00';
    const expected = '2025-06-30T08:00:00.000+02:00';
    expect(parseEmail(body, new Date('2025-06-30T06:05:00Z'))?.transactedAt).toBe(expected);
    expect(parseEmail(body, { receivedAt: '2025-06-30T06:05:00Z' })?.transactedAt).toBe(expected);
  });

  it('falls back to now when receivedAt is unparseable', () => {
    const tx = parseEmail(
      'Payment R 10.00 From Transaction Account Reference: X Thursday, 16 July at 08:00',
      'not a date',
    );
    expect(tx?.transactedAt).toBe('2026-07-16T08:00:00.000+02:00');
  });
});

describe('account names', () => {
  it('recognises custom account names', () => {
    const tx = parseEmail(
      'Transfer R 500.00 From Everyday Account To Vault Savings Monday, 6 July at 12:00',
      { accountNames: ['Everyday Account', 'Vault Savings'] },
    );
    expect(tx).toMatchObject({
      fromAccountRaw: 'Everyday Account',
      toAccountRaw: 'Vault Savings',
    });
  });

  it('leaves accounts unresolved when a name is not in the configured list', () => {
    const tx = parseEmail(
      'Transfer R 500.00 From Everyday Account To Vault Savings Monday, 6 July at 12:00',
    );
    expect(tx?.fromAccountRaw).toBeUndefined();
    expect(tx?.toAccountRaw).toBeUndefined();
  });

  it('treats regex metacharacters in account names literally', () => {
    const tx = parseEmail(
      'Transfer R 500.00 From Savings (ZAR) To Demand Savings Monday, 6 July at 12:00',
      { accountNames: ['Savings (ZAR)', 'Demand Savings'] },
    );
    expect(tx?.fromAccountRaw).toBe('Savings (ZAR)');
  });

  it('prefers a masked account number over a name', () => {
    const tx = parseEmail(
      'Payment R 100.00 From account ending ***5678 Reference: X Monday, 6 July at 12:00',
    );
    expect(tx?.fromAccountRaw).toBe('account ending ***5678');
  });

  it('keeps a bank account suffix separate from the card suffix', () => {
    const tx = parseEmail(
      'Card payment Example Store ZA – R 25.00 From ***1234 Card ending ***5678 ' +
      'Monday, 6 July at 12:00 Available balance: R 900.00',
    );
    expect(tx).toMatchObject({
      fromAccountRaw: 'account ending ***1234',
      cardEndingRaw: '***5678',
    });
  });

  it('recognises a masked destination account without the account ending label', () => {
    const tx = parseEmail(
      'Real-time payment received R 75.00 To ***2468 Reference: Example ' +
      'Monday, 6 July at 12:00 Available balance: R 975.00',
    );
    expect(tx?.toAccountRaw).toBe('account ending ***2468');
  });

  it('exposes the built-in account names', () => {
    expect(DEFAULT_ACCOUNT_NAMES).toContain('Transaction Account');
  });
});

describe('raw (un-normalised) email input', () => {
  // Regression: before entity-stripping was shared with parseEmail, reparsing a
  // stored raw email left "R&nbsp;13,106.43" unmatched, so the amount pattern
  // fell through to the balance line — the payment amount was recorded as the
  // balance.
  it('parses the payment amount, not the balance, when &nbsp; and styles leak in', () => {
    const tx = parseEmail(
      "<style>.x{font-family:'Open Sans'}</style> Important notice " +
      'Incoming payment R&nbsp;13,106.43 To account ending ***5678 ' +
      'Reference: Sam Nkosi Monday, 29 June at 14:07 ' +
      'Available balance: R 34,090.32'
    );
    expect(tx).toMatchObject({
      type: 'incoming_payment',
      direction: 'credit',
      amount: 13106.43,
      description: 'Sam Nkosi',
      balanceAfter: 34090.32,
    });
  });

  it('normalizeEmailText is idempotent', () => {
    const once = normalizeEmailText('<p>R&nbsp;1,120.00</p>  <b>x</b>');
    expect(normalizeEmailText(once)).toBe(once);
    expect(once).toBe('R 1,120.00 x');
  });

  it('normalizeEmailText decodes &amp; last, so escaped entities stay escaped', () => {
    expect(normalizeEmailText('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(normalizeEmailText('a &amp;lt;b&amp;gt; c')).toBe('a &lt;b&gt; c');
    expect(normalizeEmailText('&amp;quot;x&amp;#39;')).toBe('&quot;x&#39;');
  });
});

describe('looksTransactional', () => {
  it('recognises money-movement mail by its balance line', () => {
    expect(looksTransactional(
      'Card payment TEST ZA – R 10.00 Available balance: R 1,000.00'
    )).toBe(true);
  });

  it('recognises transfers, which carry a rate line instead of a balance', () => {
    expect(looksTransactional(
      'Forex transfer R 3,296.84 to £ 149.04 Exchange Rate 1 GBP = 22.12 ZAR'
    )).toBe(true);
  });

  it('rejects marketing and one-time-PIN mail', () => {
    expect(looksTransactional('Your one-time PIN is 123456')).toBe(false);
    expect(looksTransactional('Win a trip! Enter our competition today.')).toBe(false);
  });

  it('sees through HTML entities and tags', () => {
    expect(looksTransactional('<p>Available&nbsp;balance: R&nbsp;1,000.00</p>')).toBe(true);
  });
});

describe('deriveFlow', () => {
  it('classifies transfers regardless of direction', () => {
    expect(deriveFlow('transfer', 'debit')).toBe('transfer');
    expect(deriveFlow('transfer', 'credit')).toBe('transfer');
    expect(deriveFlow('forex_transfer', 'debit')).toBe('transfer');
  });

  it('classifies credits as income, except card reversals', () => {
    expect(deriveFlow('incoming_payment', 'credit')).toBe('income');
    expect(deriveFlow('card_reversal', 'credit')).toBe('expense');
  });

  it('classifies debits as expense', () => {
    expect(deriveFlow('card_payment', 'debit')).toBe('expense');
    expect(deriveFlow('payment', 'debit')).toBe('expense');
    expect(deriveFlow('debit_order', 'debit')).toBe('expense');
    expect(deriveFlow('atm_withdrawal', 'debit')).toBe('expense');
  });
});
