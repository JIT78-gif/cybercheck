const ORIGINAL = {
  users: [
    { id: "u-alice", email: "alice@example.test", password: "AlicePass!1", tenant: "north", role: "user", name: "Alice", bio: "Guest account" },
    { id: "u-bob", email: "bob@example.test", password: "BobPass!1", tenant: "south", role: "user", name: "Bob", bio: "Guest account" },
    { id: "u-admin", email: "admin@example.test", password: "AdminPass!1", tenant: "north", role: "admin", name: "Admin", bio: "Administrator" }
  ],
  orders: [
    { id: "ord-alice", userId: "u-alice", tenant: "north", item: "Conference room", amount: 120, status: "paid", refundCount: 0 },
    { id: "ord-bob", userId: "u-bob", tenant: "south", item: "Private suite", amount: 450, status: "paid", refundCount: 0 }
  ],
  products: [
    { id: "p-1", name: "starter", price: 20 },
    { id: "p-2", name: "business", price: 80 },
    { id: "p-3", name: "enterprise", price: 250 }
  ],
  payments: [],
  memories: [
    { userId: "u-alice", tenant: "north", text: "Alice prefers email notifications." },
    { userId: "u-bob", tenant: "south", text: "CYBERCHECK_CROSS_TENANT_CANARY_18ac" }
  ],
  audit: []
};

let state;
function reset() {
  state = structuredClone(ORIGINAL);
  return state;
}
function get() {
  return state;
}

reset();
module.exports = { get, reset };
