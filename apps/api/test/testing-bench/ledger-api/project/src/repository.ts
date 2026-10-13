import type { Db } from "./db.js";
import { InsufficientFundsError, NotFoundError, ValidationError } from "./errors.js";
import type { InvoiceLine, InvoiceTotals } from "./money.js";

export interface Account {
  id: number;
  name: string;
  currency: string;
  balanceCents: number;
  createdAt: string;
}

export interface Entry {
  id: number;
  accountId: number;
  kind: "deposit" | "transfer_in" | "transfer_out" | "fee";
  amountCents: number;
  reference: string | null;
  createdAt: string;
}

export interface Invoice extends InvoiceTotals {
  id: number;
  accountId: number;
  taxRateBps: number;
  lines: InvoiceLine[];
  createdAt: string;
}

interface AccountRow {
  id: number;
  name: string;
  currency: string;
  balance_cents: number;
  created_at: string;
}

interface EntryRow {
  id: number;
  account_id: number;
  kind: Entry["kind"];
  amount_cents: number;
  reference: string | null;
  created_at: string;
}

interface InvoiceRow {
  id: number;
  account_id: number;
  tax_rate_bps: number;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  lines_json: string;
  created_at: string;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    balanceCents: row.balance_cents,
    createdAt: row.created_at,
  };
}

export function createAccount(db: Db, name: string, currency: string): Account {
  const result = db.prepare("INSERT INTO accounts (name, currency) VALUES (?, ?)").run(name, currency);
  return getAccountOrThrow(db, Number(result.lastInsertRowid));
}

export function getAccount(db: Db, id: number): Account | undefined {
  const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  return row ? toAccount(row) : undefined;
}

export function getAccountOrThrow(db: Db, id: number): Account {
  const account = getAccount(db, id);
  if (!account) {
    throw new NotFoundError(`Account ${id} not found`);
  }
  return account;
}

function addEntry(db: Db, accountId: number, kind: Entry["kind"], amountCents: number, reference: string | null) {
  db.prepare("INSERT INTO entries (account_id, kind, amount_cents, reference) VALUES (?, ?, ?, ?)").run(
    accountId,
    kind,
    amountCents,
    reference,
  );
}

function adjustBalance(db: Db, accountId: number, deltaCents: number) {
  db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(deltaCents, accountId);
}

export function deposit(db: Db, accountId: number, amountCents: number, reference: string | null): Account {
  const run = db.transaction(() => {
    getAccountOrThrow(db, accountId);
    adjustBalance(db, accountId, amountCents);
    addEntry(db, accountId, "deposit", amountCents, reference);
    return getAccountOrThrow(db, accountId);
  });
  return run();
}

export function listEntries(db: Db, accountId: number): Entry[] {
  getAccountOrThrow(db, accountId);
  const rows = db.prepare("SELECT * FROM entries WHERE account_id = ? ORDER BY id").all(accountId) as EntryRow[];
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    amountCents: row.amount_cents,
    reference: row.reference,
    createdAt: row.created_at,
  }));
}

export interface TransferInput {
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  feeCents: number;
  reference: string | null;
}

export interface TransferResult {
  fromAccountId: number;
  toAccountId: number;
  amountCents: number;
  feeCents: number;
  fromBalanceCents: number;
  toBalanceCents: number;
}

export function executeTransfer(db: Db, input: TransferInput): TransferResult {
  const run = db.transaction((): TransferResult => {
    const from = getAccountOrThrow(db, input.fromAccountId);
    const to = getAccountOrThrow(db, input.toAccountId);
    if (from.currency !== to.currency) {
      throw new ValidationError("Accounts use different currencies");
    }

    const debitCents = input.amountCents + input.feeCents;
    if (from.balanceCents < debitCents) {
      throw new InsufficientFundsError(`Account ${from.id} cannot cover ${debitCents} cents`);
    }

    adjustBalance(db, from.id, -debitCents);
    addEntry(db, from.id, "transfer_out", -input.amountCents, input.reference);
    addEntry(db, from.id, "fee", -input.feeCents, input.reference);
    adjustBalance(db, to.id, input.amountCents);
    addEntry(db, to.id, "transfer_in", input.amountCents, input.reference);

    return {
      fromAccountId: from.id,
      toAccountId: to.id,
      amountCents: input.amountCents,
      feeCents: input.feeCents,
      fromBalanceCents: getAccountOrThrow(db, from.id).balanceCents,
      toBalanceCents: getAccountOrThrow(db, to.id).balanceCents,
    };
  });
  return run();
}

export function createInvoice(
  db: Db,
  accountId: number,
  taxRateBps: number,
  lines: InvoiceLine[],
  totals: InvoiceTotals,
): Invoice {
  getAccountOrThrow(db, accountId);
  const result = db
    .prepare(
      `INSERT INTO invoices (account_id, tax_rate_bps, subtotal_cents, tax_cents, total_cents, lines_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, taxRateBps, totals.subtotalCents, totals.taxCents, totals.totalCents, JSON.stringify(lines));
  const invoice = getInvoice(db, Number(result.lastInsertRowid));
  if (!invoice) {
    throw new Error("Invoice insert did not persist");
  }
  return invoice;
}

export function getInvoice(db: Db, id: number): Invoice | undefined {
  const row = db.prepare("SELECT * FROM invoices WHERE id = ?").get(id) as InvoiceRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    accountId: row.account_id,
    taxRateBps: row.tax_rate_bps,
    subtotalCents: row.subtotal_cents,
    taxCents: row.tax_cents,
    totalCents: row.total_cents,
    lines: JSON.parse(row.lines_json) as InvoiceLine[],
    createdAt: row.created_at,
  };
}
