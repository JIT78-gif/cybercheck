import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin'))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL
    );
  `);
}
