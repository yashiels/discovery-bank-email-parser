#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveFlow, looksTransactional, normalizeEmailText, parseEmail } from './parser.js';
import type { ParsedTransaction, TransactionFlow } from './parser.js';

interface GogMessage {
  id: string;
  from: string;
  internalDateIso: string;
  body: string;
  subject: string;
}

interface GogEnvelope {
  messages: GogMessage[];
  nextPageToken: string;
}

type IgnoredClassification = 'duplicate-id' | 'declined-card' | 'trusted-nontransaction';
type RejectedClassification = 'untrusted-sender' | 'unparsed-transaction';

interface ClassifiedMessage<TClassification extends string> {
  messageId: string;
  classification: TClassification;
}

export interface GogTransaction extends ParsedTransaction {
  messageId: string;
  flow: TransactionFlow;
}

export interface GogImportResult {
  coverage: 'notification-only';
  coverageComplete: boolean;
  sourceMessageCount: number;
  uniqueMessageCount: number;
  trustedNontransactionMessageCount: number;
  declinedCardMessageCount: number;
  unparsedTransactionalMessageCount: number;
  transactions: GogTransaction[];
  rejected: ClassifiedMessage<RejectedClassification>[];
  ignored: ClassifiedMessage<IgnoredClassification>[];
  errors: Array<{ messageId: string; code: 'unparsed-transaction'; message: string }>;
}

export class GogInputError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(message: Record<string, unknown>, field: keyof GogMessage, index: number): string {
  const value = message[field];
  if (typeof value !== 'string') throw new GogInputError(`messages[${index}].${field} must be a string`);
  return value;
}

function isReceiptTimestamp(value: string): boolean {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) return false;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw = '0', offsetHourRaw = '0', offsetMinuteRaw = '0'] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = Number(offsetHourRaw);
  const offsetMinute = Number(offsetMinuteRaw);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  return day >= 1
    && day <= daysInMonth
    && hour <= 23
    && minute <= 59
    && second <= 59
    && offsetHour <= 14
    && offsetMinute <= 59
    && (offsetHour < 14 || offsetMinute === 0)
    && !Number.isNaN(new Date(value).getTime());
}

function validateEnvelope(value: unknown): GogEnvelope {
  if (!isRecord(value)) throw new GogInputError('input must be a JSON object');
  if (!Array.isArray(value.messages)) throw new GogInputError('messages must be an array');
  if (typeof value.nextPageToken !== 'string') throw new GogInputError('nextPageToken must be a string');
  if (value.nextPageToken.trim()) throw new GogInputError('nextPageToken must be empty; rerun gog with --all to collect every page');

  const messages = value.messages.map((candidate, index) => {
    if (!isRecord(candidate)) throw new GogInputError(`messages[${index}] must be an object`);
    const id = requireString(candidate, 'id', index);
    const from = requireString(candidate, 'from', index);
    const internalDateIso = requireString(candidate, 'internalDateIso', index);
    const body = requireString(candidate, 'body', index);
    const subject = requireString(candidate, 'subject', index);
    if (!id.trim()) throw new GogInputError(`messages[${index}].id must not be empty`);
    if (!from.trim()) throw new GogInputError(`messages[${index}].from must not be empty`);
    if (!isReceiptTimestamp(internalDateIso)) {
      throw new GogInputError(`messages[${index}].internalDateIso must be a valid ISO 8601 timestamp with a timezone`);
    }
    return { id, from, internalDateIso, body, subject };
  });

  return { messages, nextPageToken: value.nextPageToken };
}

function mailboxFromHeader(value: string): string | null {
  const trimmed = value.trim();
  const bracketed = trimmed.match(/^[^<>]*<\s*([^<>\s]+@[^<>\s]+)\s*>$/);
  const mailbox = bracketed?.[1] ?? (/^[^<>\s]+@[^<>\s]+$/.test(trimmed) ? trimmed : null);
  return mailbox?.toLowerCase() ?? null;
}

function isDeclinedCard(message: GogMessage): boolean {
  const text = normalizeEmailText(`${message.subject} ${message.body}`);
  return /\bcard(?:\s+payment)?\b/i.test(text) && /\bdeclined\b/i.test(text);
}

function looksLikeMoneyMovement(message: GogMessage): boolean {
  const subject = normalizeEmailText(message.subject);
  const body = normalizeEmailText(message.body);
  const text = `${subject} ${body}`.trim();
  const hasAmount = /\b(?:R|ZAR|[A-Z]{3})\s*[\d,]+\.\d{2}\b/.test(text);
  const hasDirectLabelAmount = /\b(?:incoming\s+payment|real-time\s+payment\s+received|discovery\s+pay|debit\s+order|forex\s+transfer|transfer|atm\s+withdrawal|payment|card\s+payment(?:\s+reversal)?)\b\s*(?:(?:confirmation|completed|received|notification)\s*:?[\s]*)?(?:Amount\s*:?[\s]*)?(?:R|ZAR|[A-Z]{3})\s*[\d,]+\.\d{2}\b/i.test(text);
  const hasMerchantLabelAmount = /\b(?:card\s+payment(?:\s+reversal)?|cash\s+deposit)\b\s+[^.!?]+?\s+[–—-]\s+(?:R|ZAR|[A-Z]{3})\s*[\d,]+\.\d{2}\b/i.test(text);
  const hasAccountStructure = /\b(?:From|To)\s+(?:(?:account\s+ending\s+)?\*+\d{4}|Credit\s+Card|Demand\s+Savings|GBP\s+Account|Notice\s+Savings|Transaction\s+Account)\b/i.test(text);
  const hasReceiptDate = /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,\s+\d{1,2}\s+\w+\s+at\s+\d{2}:\d{2}\b/i.test(text);
  const hasReceiptField = hasReceiptDate && /\b(?:From|To|Reference:|Card\s+ending|Available\s+balance|Exchange\s+Rate)\b/i.test(text);
  const hasGenuineTransactionSubject = /^(?:card\s+payment(?:\s+reversal)?|cash\s+deposit|incoming\s+payment|real-time\s+payment\s+received|discovery\s+pay|debit\s+order|forex\s+transfer|transfer|atm\s+withdrawal|payment)(?:\s+(?:notification|confirmation|alert))?$/i.test(subject);
  const hasStructuredLabelAmount = (hasDirectLabelAmount || hasMerchantLabelAmount)
    && (hasAccountStructure || hasReceiptField || hasMerchantLabelAmount);
  return looksTransactional(text)
    || hasStructuredLabelAmount
    || (hasGenuineTransactionSubject && hasAmount && hasReceiptField);
}

function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export function parseGogInput(raw: string): GogEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GogInputError('stdin must contain valid JSON');
  }
  return validateEnvelope(parsed);
}

export function importGogEnvelope(value: unknown): GogImportResult {
  const envelope = validateEnvelope(value);
  const transactions: GogTransaction[] = [];
  const rejected: GogImportResult['rejected'] = [];
  const ignored: GogImportResult['ignored'] = [];
  const errors: GogImportResult['errors'] = [];
  const seenIds = new Set<string>();
  let trustedNontransactionMessageCount = 0;
  let declinedCardMessageCount = 0;
  let unparsedTransactionalMessageCount = 0;

  for (const message of envelope.messages) {
    if (seenIds.has(message.id)) {
      ignored.push({ messageId: message.id, classification: 'duplicate-id' });
      continue;
    }
    seenIds.add(message.id);

    if (mailboxFromHeader(message.from) !== 'no-reply@discovery.bank') {
      rejected.push({ messageId: message.id, classification: 'untrusted-sender' });
      continue;
    }

    if (isDeclinedCard(message)) {
      declinedCardMessageCount += 1;
      ignored.push({ messageId: message.id, classification: 'declined-card' });
      continue;
    }

    const transaction = parseEmail(message.body, message.internalDateIso);
    if (transaction) {
      transactions.push({
        messageId: message.id,
        ...transaction,
        flow: deriveFlow(transaction.type, transaction.direction),
      });
      continue;
    }

    if (looksLikeMoneyMovement(message)) {
      unparsedTransactionalMessageCount += 1;
      rejected.push({ messageId: message.id, classification: 'unparsed-transaction' });
      errors.push({
        messageId: message.id,
        code: 'unparsed-transaction',
        message: 'Trusted transactional notification was not recognised',
      });
      continue;
    }

    trustedNontransactionMessageCount += 1;
    ignored.push({ messageId: message.id, classification: 'trusted-nontransaction' });
  }

  return {
    coverage: 'notification-only',
    coverageComplete: unparsedTransactionalMessageCount === 0,
    sourceMessageCount: envelope.messages.length,
    uniqueMessageCount: seenIds.size,
    trustedNontransactionMessageCount,
    declinedCardMessageCount,
    unparsedTransactionalMessageCount,
    transactions,
    rejected,
    ignored,
    errors,
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

export async function runGogCli(): Promise<void> {
  try {
    const envelope = parseGogInput(await readStdin());
    process.stdout.write(`${JSON.stringify(importGogEnvelope(envelope), null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`discovery-bank-gog: ${message}\n`);
    process.exitCode = 2;
  }
}

if (isDirectExecution()) {
  await runGogCli();
}
