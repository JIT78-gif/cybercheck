import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotal, validQuantity } from "../src/pricing.js";

test("cart total multiplies price by quantity", () => {
  assert.equal(cartTotal([{ price_cents: 250, quantity: 2 }, { price_cents: 100, quantity: 1 }]), 600);
});

test("empty cart costs nothing", () => {
  assert.equal(cartTotal([]), 0);
});

test("quantities are 1 to 10", () => {
  assert.equal(validQuantity(1), true);
  assert.equal(validQuantity(10), true);
  assert.equal(validQuantity(0), false);
  assert.equal(validQuantity(11), false);
  assert.equal(validQuantity(1.5), false);
});
