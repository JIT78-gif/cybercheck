// Cart arithmetic, kept apart from the routes so it can be tested on its own.

/** Total of a cart in cents: the sum of price times quantity over all lines. */
export function cartTotal(lines) {
  return lines.reduce((sum, l) => sum + l.price_cents * l.quantity, 0);
}

/** Quantities are whole numbers from 1 to 10 (see README). */
export function validQuantity(q) {
  return Number.isInteger(q) && q >= 1 && q <= 10;
}
