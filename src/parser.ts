export type TransactionType =
  | 'card_payment'
  | 'card_reversal'
  | 'incoming_payment'
  | 'payment'
  | 'debit_order'
  | 'forex_transfer'
  | 'transfer'
  | 'atm_withdrawal';

export type TransactionFlow = 'expense' | 'income' | 'transfer';

/**
 * User-facing classification, derived from the bank's transaction type and
 * direction. `card_reversal` stays `expense` so refunds subtract from net
 * spend rather than inflating income.
 */
export function deriveFlow(
  type: TransactionType,
  direction: 'debit' | 'credit'
): TransactionFlow {
  if (type === 'transfer' || type === 'forex_transfer') return 'transfer';
  if (direction === 'credit' && type !== 'card_reversal') return 'income';
  return 'expense';
}

export interface ParsedTransaction {
  type: TransactionType;
  direction: 'debit' | 'credit';
  /** ZAR amount. `0` for foreign-currency card payments — see `foreignAmount`. */
  amount: number;
  foreignAmount?: number;
  foreignCurrency?: string;
  exchangeRate?: number;
  description?: string;
  fromAccountRaw?: string;
  toAccountRaw?: string;
  cardEndingRaw?: string;
  balanceAfter?: number;
  /** ISO 8601, always with the `+02:00` (SAST) offset. */
  transactedAt: string;
}

/**
 * Whether an email looks like money-movement mail at all.
 *
 * Most emails that fail to parse are supposed to fail: marketing blasts,
 * statement-ready notices, competition mailers. Use this to tell those apart
 * from a real transaction the parser couldn't handle — e.g. to alert only on
 * the latter.
 *
 * `"Available balance:"` covers card payments, payments, debit orders, incoming
 * payments and ATM withdrawals. Transfers and forex transfers omit it, so the
 * exchange-rate line stands in for those.
 */
export function looksTransactional(rawText: string): boolean {
  const text = normalizeEmailText(rawText);
  return TRANSACTIONAL_MARKERS.some(re => re.test(text));
}

const TRANSACTIONAL_MARKERS = [
  /Available\s+balance:/i,
  /Exchange\s+Rate\s+1\s+\w+\s*=\s*[\d.]+\s+ZAR/i,
];

export interface ParseOptions {
  /**
   * When the email was received. Discovery's emails carry a day and month but
   * no year, so the year is inferred relative to this instant. Pass the
   * original receipt time when reparsing stored emails, otherwise a message
   * reparsed months later infers the wrong year. Defaults to now.
   */
  receivedAt?: Date | string;
  /**
   * Account names to recognise in `From <name>` / `To <name>` lines. Discovery
   * shows the product name rather than a number for own-account references, and
   * the set differs per customer. Defaults to {@link DEFAULT_ACCOUNT_NAMES}.
   */
  accountNames?: readonly string[];
}

/** Account product names recognised out of the box. */
export const DEFAULT_ACCOUNT_NAMES: readonly string[] = [
  'Credit Card',
  'Demand Savings',
  'GBP Account',
  'Notice Savings',
  'Transaction Account',
];

function parseAmount(raw: string): number {
  return parseFloat(raw.replace(/,/g, ''));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDate(raw: string, anchor: Date): string | null {
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  const match = raw.match(/(\d{1,2})\s+(\w+)\s+at\s+(\d{2}:\d{2})/i);
  if (!match) return null;
  const [, day, monthName, time] = match;
  const month = months[monthName.toLowerCase()];
  if (!month) return null;

  // Discovery emails give South African time (SAST, UTC+2, no DST) with no
  // year. Anchor inference to when this email was originally received so
  // reparsing it months or years later is deterministic. If the inferred date
  // lands more than a day after receipt (e.g. 31 December received on
  // 1 January), the transaction happened in the previous year.
  const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
  const build = (y: number) => `${y}-${month}-${day.padStart(2, '0')}T${time}:00.000+02:00`;
  let year = new Date(anchor.getTime() + SAST_OFFSET_MS).getUTCFullYear();
  if (new Date(build(year)).getTime() - anchor.getTime() > 24 * 3600 * 1000) year -= 1;
  const result = build(year);
  return Number.isNaN(new Date(result).getTime()) ? null : result;
}

function dateAnchor(value?: Date | string): Date {
  const parsed = value instanceof Date ? value : value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Strip `<style>`/`<script>` blocks and tags, decode the HTML entities
 * Discovery's emails use, and collapse whitespace — so `"R&nbsp;1,120.00"`
 * becomes `"R 1,120.00"` and the amount patterns (which expect a literal space
 * after `R`) match.
 *
 * {@link parseEmail} calls this itself; it is exported so callers can store the
 * same normalised text they parsed. Idempotent — running it on already
 * normalised text is a no-op.
 */
export function normalizeEmailText(raw: string): string {
  return raw
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    // Last, so an escaped entity like `&amp;lt;` decodes to `&lt;`, not `<`.
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse the text or HTML body of a Discovery Bank transaction notification.
 *
 * Returns `null` for anything that isn't a transaction notification — OTPs,
 * marketing, statements — and for transaction emails whose amount or date can't
 * be read. Callers should treat `null` as "not a transaction", not as an error.
 *
 * @param rawText Email body, text or HTML. Normalised internally.
 * @param options Receipt time for year inference, or a `Date`/ISO string
 *   shorthand for `{ receivedAt }`.
 */
export function parseEmail(
  rawText: string,
  options?: ParseOptions | Date | string
): ParsedTransaction | null {
  const opts: ParseOptions =
    options instanceof Date || typeof options === 'string'
      ? { receivedAt: options }
      : options ?? {};

  const text = normalizeEmailText(rawText);
  const anchor = dateAnchor(opts.receivedAt);
  const accountNames = (opts.accountNames ?? DEFAULT_ACCOUNT_NAMES)
    .map(escapeRegExp)
    .join('|');

  // ── Detect transaction type ───────────────────────────────────────────────
  // card_reversal must be checked before card_payment
  let type: TransactionType | null = null;
  if      (/\bCard\s+payment\s+reversal\b/i.test(text)) type = 'card_reversal';
  // Discovery labels a card refund "Cash deposit", but the body has card-payment
  // shape: "MERCHANT – CURRENCY AMOUNT", "To Credit Card", "Card ending". Match
  // on that shape, not the label alone, and treat it as a reversal so the refund
  // nets against the original spend instead of being booked as income. A literal
  // cash deposit (no card, no merchant) has no such line and stays unhandled.
  else if (/\bCash\s+deposit\b/i.test(text) && /\bCard\s+ending\b/i.test(text)) type = 'card_reversal';
  else if (/\bCard\s+payment\b/i.test(text))            type = 'card_payment';
  // Discovery Pay is a person-to-person send. It's a payment in every respect
  // the model cares about, so it shares the 'payment' type rather than adding
  // one; checked early because "Pay" never matches the generic branch below.
  else if (/\bDiscovery\s+Pay\b/i.test(text))           type = 'payment';
  else if (/\b(?:Incoming\s+payment|Real-time\s+payment\s+received)\b/i.test(text)) type = 'incoming_payment';
  else if (/\bATM\s+withdrawal\b/i.test(text))          type = 'atm_withdrawal';
  else if (/\bDebit\s+order\b/i.test(text))             type = 'debit_order';
  else if (/\bForex\s+transfer\b/i.test(text))          type = 'forex_transfer';
  else if (/\bTransfer\b/i.test(text))                  type = 'transfer';
  else if (/\bPayment\b/i.test(text))                   type = 'payment';
  if (!type) return null;

  // ── Common fields ─────────────────────────────────────────────────────────

  // Available balance — Discovery sometimes omits the space: "R37,083.18"
  const balanceMatch = text.match(/Available\s+balance:\s*R\s*([\d,]+\.\d{2})/i);
  const balanceAfter = balanceMatch ? parseAmount(balanceMatch[1]) : undefined;

  // Date: "Friday, 5 June at 17:42"
  const dateMatch = text.match(/\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,\s+\d{1,2}\s+\w+\s+at\s+\d{2}:\d{2})\b/i);
  const transactedAt = dateMatch ? parseDate(dateMatch[1], anchor) : null;
  if (!transactedAt) return null;

  // Reference line
  const refMatch = text.match(/Reference:\s+(.+?)(?=\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,|\s+Available\s+balance|$)/i);
  const reference = refMatch ? refMatch[1].trim() : undefined;

  // "Card ending ***1234" on card payments, "Card ending: ***1234" on refunds
  const cardMatch = text.match(/Card\s+ending:?\s+\*+(\d{4})/i);
  const cardEndingRaw = cardMatch ? `***${cardMatch[1]}` : undefined;

  // Account references
  const fromEndingMatch = text.match(/From\s+(?:account\s+ending\s+)?(\*+\d{4})/i);
  const toEndingMatch   = text.match(/To\s+(?:account\s+ending\s+)?(\*+\d{4})/i);
  const fromNameMatch = accountNames ? text.match(new RegExp(`From\\s+(${accountNames})`, 'i')) : null;
  const toNameMatch   = accountNames ? text.match(new RegExp(`To\\s+(${accountNames})`, 'i')) : null;

  const fromAccountRaw = fromEndingMatch
    ? `account ending ${fromEndingMatch[1]}`
    : (fromNameMatch?.[1] ?? undefined);

  const toAccountRaw = toEndingMatch
    ? `account ending ${toEndingMatch[1]}`
    : (toNameMatch?.[1] ?? undefined);

  // ── Type-specific parsing ─────────────────────────────────────────────────

  switch (type) {
    case 'card_payment':
    case 'card_reversal': {
      const isReversal = type === 'card_reversal';
      const direction  = isReversal ? 'credit' : 'debit';

      // "Card payment [reversal] MERCHANT – CURRENCY AMOUNT", or the same line
      // under Discovery's "Cash deposit" refund label.
      // Currency is R or ZAR for local transactions, 3-letter ISO code for foreign.
      // [–—-] covers en-dash, em-dash, and hyphen-minus.
      const lineMatch = text.match(
        /(?:Card\s+payment(?:\s+reversal)?|Cash\s+deposit)\s+(.+?)\s+[–—-]\s+(R|ZAR|[A-Z]{3})\s*([\d,]+\.\d{2})/i
      );
      if (!lineMatch) return null;

      const merchant  = lineMatch[1].trim();
      const currency  = lineMatch[2].toUpperCase();
      const parsedAmt = parseAmount(lineMatch[3]);

      const explicitBankAccountRaw = isReversal
        ? (toEndingMatch ? toAccountRaw : undefined)
        : (fromEndingMatch ? fromAccountRaw : undefined);
      const namedAccountRaw = isReversal ? toAccountRaw : fromAccountRaw;
      const accountRaw = explicitBankAccountRaw
        ?? (cardEndingRaw ? `account ending ${cardEndingRaw}` : undefined)
        ?? namedAccountRaw;

      if (currency === 'R' || currency === 'ZAR') {
        return {
          type, direction,
          amount: parsedAmt,
          description: merchant,
          fromAccountRaw: isReversal ? undefined : accountRaw,
          toAccountRaw:   isReversal ? accountRaw : undefined,
          cardEndingRaw,
          balanceAfter,
          transactedAt,
        };
      }

      // Foreign currency — the ZAR equivalent is not shown in the email, so the
      // caller has to convert (or wait for the statement) to fill `amount`.
      return {
        type, direction,
        amount: 0,
        foreignAmount:    parsedAmt,
        foreignCurrency:  currency,
        description:      merchant,
        fromAccountRaw: isReversal ? undefined : accountRaw,
        toAccountRaw:   isReversal ? accountRaw : undefined,
        cardEndingRaw,
        balanceAfter,
        transactedAt,
      };
    }

    case 'atm_withdrawal': {
      // "ATM withdrawal At OR Tambo Branch Kempton P - R 990.00"
      // Uses a hyphen-minus, not an em-dash
      const atmMatch = text.match(/ATM\s+withdrawal\s+(.+?)\s*[-–—]\s*R\s*([\d,]+\.\d{2})/i);
      if (!atmMatch) return null;
      return {
        type,
        direction: 'debit',
        amount: parseAmount(atmMatch[2]),
        description: atmMatch[1].trim(),
        fromAccountRaw,
        balanceAfter,
        transactedAt,
      };
    }

    case 'incoming_payment': {
      const match = text.match(/\b(?:Incoming\s+payment|Real-time\s+payment\s+received)\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      return {
        type, direction: 'credit', amount: parseAmount(match[1]),
        description: reference, toAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'payment': {
      // "Payment R 300.00 From Demand Savings Reference: Parking", or
      // "Discovery Pay R 2.50 To Bob Smith From account ending ***1234".
      const match = text.match(/\b(?:Discovery\s+Pay|Payment)\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;

      // Only Discovery Pay names the payee. Prefer it over the free-text
      // reference: it's the counterparty, so money sent to someone lands on the
      // same person as money received from them, where a chatty reference would
      // group with nothing.
      const payeeMatch = text.match(
        /\bDiscovery\s+Pay\s+(?:R|ZAR)\s*[\d,]+\.\d{2}\s+To\s+(.+?)\s+(?:From\b|Reference:)/i
      );

      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        description: payeeMatch?.[1].trim() ?? reference,
        fromAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'debit_order': {
      const match = text.match(/\bDebit\s+order\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        description: reference, fromAccountRaw, balanceAfter, transactedAt,
      };
    }

    case 'forex_transfer': {
      // "R 3,296.84 to £ 149.04"
      const forexMatch = text.match(/R\s*([\d,]+\.\d{2})\s+to\s+([£$€])\s*([\d,]+\.\d{2})/i);
      if (!forexMatch) return null;
      const rateMatch  = text.match(/Exchange\s+Rate\s+1\s+\w+\s*=\s*([\d.]+)\s+ZAR/i);
      return {
        type, direction: 'debit',
        amount: parseAmount(forexMatch[1]),
        foreignAmount: parseAmount(forexMatch[3]),
        foreignCurrency: forexMatch[2] === '£' ? 'GBP' : forexMatch[2] === '$' ? 'USD' : 'EUR',
        exchangeRate: rateMatch ? parseFloat(rateMatch[1]) : undefined,
        fromAccountRaw,
        toAccountRaw,
        transactedAt,
      };
    }

    case 'transfer': {
      const match = text.match(/\bTransfer\s+(?:R|ZAR)\s*([\d,]+\.\d{2})/i);
      if (!match) return null;
      return {
        type, direction: 'debit', amount: parseAmount(match[1]),
        fromAccountRaw, toAccountRaw, transactedAt,
      };
    }

    default:
      return null;
  }
}
