# @acme/shipping-quotes

Pure TypeScript library that prices parcels for our three carriers.

```ts
import { quoteShipment, cheapestQuote } from "@acme/shipping-quotes";

quoteShipment({
  carrier: "parcelpro",
  service: "standard",
  parcel: { weightGrams: 1800, lengthCm: 30, widthCm: 20, heightCm: 10 },
  insuredValueCents: 25_000,
});
```

Rules:

- Billable weight is the larger of the actual weight and the volumetric weight
  (`L x W x H / 5000` kg), rounded up to the next 100 g.
- Price = first kg rate + each additional started kg at the additional rate.
- Insurance: 1 % of the insured value, minimum 1.00, only when a value is given.
- All rate tables are in USD.

Scripts: `npm run build`, `npm run typecheck`, `npm test`.
