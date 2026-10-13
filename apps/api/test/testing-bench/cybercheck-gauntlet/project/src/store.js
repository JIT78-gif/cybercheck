const users = [
  { id: "u1", email: "alice@example.test", password: "AlicePass123!", role: "customer", name: "Alice", credit: 100 },
  { id: "u2", email: "bob@example.test", password: "BobPass123!", role: "customer", name: "Bob", credit: 75 },
  { id: "u-admin", email: "admin@example.test", password: "AdminPass123!", role: "admin", name: "Administrator", credit: 0 },
];

const products = [
  { id: "p1", name: "Notebook", price: 4.25, stock: 20 },
  { id: "p2", name: "Pen set", price: 7.5, stock: 12 },
  { id: "p3", name: "Desk lamp", price: 24.99, stock: 4 },
];

const orders = [
  { id: "o1", userId: "u1", status: "pending", total: 4.25, items: [{ productId: "p1", quantity: 1 }] },
  { id: "o2", userId: "u2", status: "paid", total: 7.5, items: [{ productId: "p2", quantity: 1 }] },
];

const payments = [];

function reset() {
  users.splice(0, users.length,
    { id: "u1", email: "alice@example.test", password: "AlicePass123!", role: "customer", name: "Alice", credit: 100 },
    { id: "u2", email: "bob@example.test", password: "BobPass123!", role: "customer", name: "Bob", credit: 75 },
    { id: "u-admin", email: "admin@example.test", password: "AdminPass123!", role: "admin", name: "Administrator", credit: 0 },
  );
  products.splice(0, products.length,
    { id: "p1", name: "Notebook", price: 4.25, stock: 20 },
    { id: "p2", name: "Pen set", price: 7.5, stock: 12 },
    { id: "p3", name: "Desk lamp", price: 24.99, stock: 4 },
  );
  orders.splice(0, orders.length,
    { id: "o1", userId: "u1", status: "pending", total: 4.25, items: [{ productId: "p1", quantity: 1 }] },
    { id: "o2", userId: "u2", status: "paid", total: 7.5, items: [{ productId: "p2", quantity: 1 }] },
  );
  payments.length = 0;
}

module.exports = { users, products, orders, payments, reset };

