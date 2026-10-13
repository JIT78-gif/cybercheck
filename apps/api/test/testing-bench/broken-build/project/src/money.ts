export type CurrencyCode = "USD" | "EUR" | "GBP";

export const DEFAULT_CURRENCY: CurrencyCode = "USD";

const formatters = new Map<CurrencyCode, Intl.NumberFormat>();

function formatterFor(currency: CurrencyCode): Intl.NumberFormat {
  let formatter = formatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
    formatters.set(currency, formatter);
  }
  return formatter;
}

export function formatMoney(amountCents: number, currency: CurrencyCode): string {
  const code = currency || DEFAULT_CURRENCY;
  return formatterFor(code).format(amountCents / 100);
}

export function percentOf(amountCents: number, percent: number): number {
  return Math.round((amountCents * percent) / 100);
}
