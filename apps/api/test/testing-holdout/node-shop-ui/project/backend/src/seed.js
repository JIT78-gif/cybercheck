// Creates the shop's admin account from ADMIN_EMAIL and ADMIN_PASSWORD (run once after the server has started).
import { migrate, pool } from "./db.js";
import { hash } from "./hash.js";

await migrate();
const email = (process.env.ADMIN_EMAIL || "admin@example.com").toLowerCase();
await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin') ON CONFLICT (email) DO UPDATE SET role = 'admin'", [email, hash(process.env.ADMIN_PASSWORD || "change-me-please")]);
console.log(`admin ready: ${email}`);
await pool.end();
process.exit(0);
