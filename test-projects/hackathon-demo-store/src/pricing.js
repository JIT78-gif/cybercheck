function checkoutQuote(subtotal, couponCode) {
  const discount = couponCode === "SAVE10" ? subtotal * 0.1 : 0;

  // DELIBERATE TESTING DEFECT: tax should be calculated after the discount.
  const tax = subtotal * 0.1;
  return {
    subtotal,
    discount,
    tax,
    total: subtotal - discount + tax,
  };
}

module.exports = { checkoutQuote };
