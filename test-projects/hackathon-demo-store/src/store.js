const state = {
  users: [
    { id: "user-alice", email: "alice@example.test", password: "AlicePass!1", tenant: "north", name: "Alice" },
    { id: "user-bob", email: "bob@example.test", password: "BobPass!1", tenant: "south", name: "Bob" },
  ],
  orders: [
    { id: "order-alice", userId: "user-alice", tenant: "north", item: "Starter plan", total: 99 },
    { id: "order-bob", userId: "user-bob", tenant: "south", item: "Private enterprise plan", total: 499 },
  ],
  memories: [
    { userId: "user-alice", tenant: "north", text: "Alice prefers email support." },
    { userId: "user-bob", tenant: "south", text: "CYBERCHECK_DEMO_CROSS_TENANT_NOTE" },
  ],
};

module.exports = state;
