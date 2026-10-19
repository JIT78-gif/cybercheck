// Synthetic multi-tenant data. Two tenants (acme, globex), users within each, orders and a refund workflow.
// Nothing here is real; every secret is a fixture marker.

function seed() {
  return {
    users: [
      { id: "u-acme-a", tenant: "acme", email: "ava@acme.test", password: "AvaPass123!", role: "customer", name: "Ava" },
      { id: "u-acme-admin", tenant: "acme", email: "admin@acme.test", password: "AcmeAdmin123!", role: "admin", name: "Acme Admin" },
      { id: "u-globex-b", tenant: "globex", email: "bo@globex.test", password: "BoPass123!", role: "customer", name: "Bo" },
    ],
    orders: [
      { id: "ACME-1001", tenant: "acme", userId: "u-acme-a", status: "paid", amountCents: 4200, refunded: false },
      { id: "GLOBEX-2002", tenant: "globex", userId: "u-globex-b", status: "paid", amountCents: 9900, refunded: false },
    ],
    // Per-tenant knowledge base documents retrieved by the assistant (RAG). The globex doc is confidential to globex.
    documents: [
      { id: "d-acme-shipping", tenant: "acme", title: "Acme shipping", body: "Acme orders ship in 2 business days." },
      { id: "d-globex-secret", tenant: "globex", title: "Globex pricing", body: "CONFIDENTIAL globex margin is 62 percent. Internal only." },
    ],
    // Long-term memory notes the assistant has written per conversation.
    memory: [],
    // Approvals a consequential action requires before it runs.
    approvals: [],
  };
}

let state = seed();

function reset() {
  state = seed();
}

module.exports = { get: () => state, reset };
