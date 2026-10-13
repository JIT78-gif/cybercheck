import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("CAFE_DB_PATH", "cafe.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS cafes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    license_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'staff'))
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    table_id INTEGER REFERENCES tables(id) ON DELETE CASCADE,
    customer_name TEXT
);
CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    number TEXT NOT NULL,
    UNIQUE (cafe_id, number)
);
CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL REFERENCES cafes(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    price REAL NOT NULL CHECK (price >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preparing', 'served', 'paid')),
    total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id INTEGER NOT NULL REFERENCES menu_items(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    unit_price REAL NOT NULL
);
"""


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
