const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = OFF;");
db.exec(`
  CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
  CREATE TABLE data_orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), amount_cents INTEGER NOT NULL);
`);

function resetDatabase() {
  db.exec(`
    DELETE FROM data_orders;
    DELETE FROM customers;
    INSERT INTO customers(id, email) VALUES (1, 'alice@example.test'), (2, 'bob@example.test');
    INSERT INTO data_orders(id, customer_id, amount_cents) VALUES (1, 1, 425), (2, 2, 750);
  `);
}

function unsafeCustomerSearch(query) {
  return db.prepare(`SELECT id, email FROM customers WHERE email LIKE '%${query}%'`).all();
}

function deleteCustomer(id) {
  db.prepare("DELETE FROM customers WHERE id = ?").run(id);
}

function orphanOrders() {
  return Number(db.prepare("SELECT COUNT(*) AS count FROM data_orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL").get().count);
}

resetDatabase();

module.exports = { db, resetDatabase, unsafeCustomerSearch, deleteCustomer, orphanOrders };

