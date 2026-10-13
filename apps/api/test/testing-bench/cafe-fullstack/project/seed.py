"""Creates the demo cafe and prints its licence key.

Run it once after the server has created the database:  python seed.py
The admin account is then created from the web app's activation screen (or POST /auth/activate)
with this licence key.
"""
import os
import secrets

from app.db import connect, init_db

init_db()
key = os.environ.get("CAFE_LICENSE_KEY") or f"LIC-{secrets.token_hex(6).upper()}"
with connect() as conn:
    row = conn.execute("SELECT license_key FROM cafes WHERE name = 'Demo Cafe'").fetchone()
    if row:
        key = row["license_key"]
    else:
        conn.execute("INSERT INTO cafes (name, license_key) VALUES ('Demo Cafe', ?)", (key,))
print(f"LICENSE_KEY={key}")
