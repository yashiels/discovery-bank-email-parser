# discovery-bank-email-parser

Turn [Discovery Bank](https://www.discovery.co.za/bank/) transaction notification emails into structured transaction objects.

Discovery Bank has no public API, so the notification emails it sends on every card swipe, debit order and transfer are the only real-time feed of your own transactions. This library reads those emails and gives you typed data you can store, categorise or budget with.

- **Zero runtime dependencies.** Runs on Node 18+, Cloudflare Workers, Deno, Bun and the browser.
- **Text or HTML.** Entity decoding and tag stripping are built in — feed it whatever the mail parser hands you.
- **Deterministic dates.** Discovery's emails carry no year; the parser infers it from the receipt time, so reparsing a stored email years later gives the same answer.
- **Typed.** Ships TypeScript declarations.

## Install

```sh
npm install discovery-bank-email-parser
```

Or straight from source, which builds the TypeScript on install:

```sh
npm install github:tanka8/discovery-bank-email-parser#main
```

npm pins the exact commit in your lockfile, so builds stay reproducible; `npm update discovery-bank-email-parser` moves you to the latest `main`.

## Usage

```ts
import { parseEmail, deriveFlow } from 'discovery-bank-email-parser';

const tx = parseEmail(
  'Card payment WOOLWORTHS BLUE BIRD ZA – R 1,259.45 From Credit Card ' +
  'Card ending ***1234 Sunday, 12 July at 11:32 Available balance: R 101,567.80'
);

// {
//   type: 'card_payment',
//   direction: 'debit',
//   amount: 1259.45,
//   description: 'WOOLWORTHS BLUE BIRD ZA',
//   fromAccountRaw: 'account ending ***1234',
//   balanceAfter: 101567.8,
//   transactedAt: '2026-07-12T11:32:00.000+02:00',
// }

deriveFlow(tx.type, tx.direction); // 'expense'
```

`parseEmail` returns `null` for anything that isn't a transaction notification — OTPs, marketing, statements — and for transaction emails whose amount or date can't be read. Treat `null` as *"not a transaction"*, not as an error.

### Reparsing stored emails

Discovery's emails give a day and month but no year, so the year is inferred relative to when the email arrived. If you're parsing an email you stored earlier, pass its original receipt time — otherwise a 2019 email reparsed today lands in the current year.

```ts
parseEmail(storedBody, { receivedAt: row.received_at });
parseEmail(storedBody, row.received_at);  // shorthand
```

### Custom account names

For own-account references Discovery prints the product name (`From Transaction Account`) rather than a number, and the set of products differs per customer. The defaults are `Credit Card`, `Demand Savings`, `GBP Account`, `Notice Savings` and `Transaction Account`. Override them if yours differ:

```ts
parseEmail(body, { accountNames: ['Everyday Account', 'Vault Savings'] });
```

Masked account numbers (`From account ending ***5678`) and card numbers (`Card ending ***1234`) are always recognised and take priority over names.

## CLI

```sh
cat notification.html | npx discovery-bank-email-parser
cat old-email.txt   | npx discovery-bank-email-parser --received-at 2025-06-30T06:05:00Z
```

Prints the parsed transaction as JSON (with `flow` added), or exits `1` if the email isn't a recognised transaction notification.

### Read-only Gmail import with gog

Pipe a complete read-only Gmail search into `discovery-bank-gog`:

```sh
gog --readonly --gmail-no-send --account user@example.com gmail messages search 'from:no-reply@discovery.bank after:2026/01/01 before:2026/02/01' --all --include-body --json --no-input | discovery-bank-gog
```

The command reads JSON from standard input and does not call Gmail, `gog`, or any external service itself. It validates the sender mailbox, original receipt timestamp, complete pagination, and required message fields; deduplicates by Gmail message ID; and reports parsed transactions plus rejected, ignored, and incomplete-coverage classifications.

This is notification-only coverage. It does not log into the bank or provide a live balance. Authorization emails can later reverse, available credit is not cash, and statements are still required for fees, interest, and completeness. Repayments and transfers between your own accounts are not new spend. A foreign-currency card notification with `amount: 0` means the ZAR amount is not yet known, not that the purchase cost nothing.

## Cloudflare Email Workers

The parser was built for a Cloudflare Email Worker, which is the cheapest way to get a real-time feed: point a route at your worker and forward Discovery's notifications to it.

```ts
import PostalMime from 'postal-mime';
import { parseEmail } from 'discovery-bank-email-parser';

export default {
  async email(message: ForwardableEmailMessage, env: Env) {
    const mail = await new PostalMime().parse(await new Response(message.raw).arrayBuffer());
    const tx = parseEmail(mail.text ?? mail.html ?? '');
    if (!tx) return;                       // not a transaction email
    await storeTransaction(env.DB, tx);
  },
};
```

Only process mail you trust. Balances and amounts come straight out of the email body, so anyone who can deliver mail to that address can write to your ledger — check the sender against `discovery.bank` (or your own forwarding address) before parsing.

## API

### `parseEmail(rawText, options?): ParsedTransaction | null`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `receivedAt` | `Date \| string` | now | Receipt time, used to infer the year |
| `accountNames` | `readonly string[]` | see above | Account product names to recognise |

`options` may also be a bare `Date` or ISO string as shorthand for `{ receivedAt }`.

### `ParsedTransaction`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | `TransactionType` | See below |
| `direction` | `'debit' \| 'credit'` | |
| `amount` | `number` | ZAR. `0` for foreign card payments — see `foreignAmount` |
| `foreignAmount` | `number?` | Present for foreign card payments and forex transfers |
| `foreignCurrency` | `string?` | ISO 4217 code |
| `exchangeRate` | `number?` | ZAR per unit of `foreignCurrency`, forex transfers only |
| `description` | `string?` | Merchant name, or the `Reference:` line |
| `fromAccountRaw` | `string?` | e.g. `'Transaction Account'`, `'account ending ***1234'` |
| `toAccountRaw` | `string?` | |
| `cardEndingRaw` | `string?` | Masked card suffix, kept separate from the bank account reference. |
| `balanceAfter` | `number?` | Available balance, when the email includes one |
| `transactedAt` | `string` | ISO 8601, always `+02:00` (SAST) |

`TransactionType` is one of `card_payment`, `card_reversal`, `incoming_payment`, `payment`, `debit_order`, `forex_transfer`, `transfer`, `atm_withdrawal`.

Two of Discovery's labels don't map to their own type. A **"Cash deposit"** email carrying a card line is a card refund, so it parses as `card_reversal` — the refund then nets against the original spend instead of showing up as income. **Discovery Pay** (person-to-person) parses as `payment`, and uniquely names the payee, which is used as `description` in preference to the free-text reference.

### `deriveFlow(type, direction): 'expense' | 'income' | 'transfer'`

Collapses type and direction into the classification you actually budget on. Transfers between your own accounts are neither income nor spend, and card reversals stay `expense` so refunds subtract from net spend instead of inflating income.

### `looksTransactional(rawText): boolean`

Whether an email is money-movement mail at all. Most emails that fail to parse are *supposed* to fail — marketing, statement notices, competition mailers — so use this to tell those apart from a real transaction the parser couldn't handle, and alert only on the latter.

```ts
const tx = parseEmail(body);
if (!tx && looksTransactional(body)) {
  await alertMe('A transaction email did not parse', body);
}
```

### `normalizeEmailText(raw): string`

Strips tags and decodes entities. `parseEmail` calls it internally; it's exported so you can store the same normalised text you parsed. Idempotent.

## Foreign card payments

Discovery's card-payment emails for foreign currency show only the foreign amount — the ZAR the card is actually charged isn't known until settlement. The parser sets `amount: 0` and fills `foreignAmount` / `foreignCurrency`, leaving the conversion to you. `forex_transfer` emails are different: they show both legs and the rate, so all three fields are populated.

## Caveats

Notification formats are Discovery's, undocumented, and change without warning. Everything here was derived from real emails, but if you see a format the parser misses, please [open an issue](https://github.com/tanka8/discovery-bank-email-parser/issues) with the email text — redact amounts and account numbers first. This project is not affiliated with or endorsed by Discovery Bank.

## Development

```sh
npm install
npm test
npm run build
```

Test fixtures are synthetic but format-faithful. When Discovery changes a format, fix the parser first, then update the fixture to the new real format.

## Credits

Extracted from a personal finance tracker. Claude (Anthropic's AI assistant) was used in the creation of this library.

## License

MIT
