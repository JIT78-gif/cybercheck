# Cafe orders

A small ordering system for a cafe: the admin sets up tables and the menu, guests check in at their
table from a QR code and order from their phone, and staff move orders forward.

## Running it

    pip install -r requirements.txt
    uvicorn app.main:app --port 8000
    python seed.py            # creates the demo cafe and prints its licence key

    cd frontend && npm ci && npm run build && npm start   # http://localhost:3000

Settings: `CAFE_DB_PATH` (SQLite file, default `cafe.db`), `CAFE_CORS_ORIGINS`, and in the frontend
`NEXT_PUBLIC_API_URL` (default `http://localhost:8000`).

## How it works

1. Activation: the cafe owner opens `/activate`, enters the licence key printed by `seed.py`, an email
   and a password. This creates the cafe's admin account (`POST /auth/activate`).
2. Sign-in: `POST /auth/login` returns a bearer token for admin and staff.
3. The admin adds tables (`POST /admin/tables`) and menu items (`POST /admin/menu`) on `/admin`.
4. A guest opens `/c/<table id>`, enters a name (`POST /customer/checkin`, which returns a session sent
   as the `X-Session` header), picks items and quantities, and places the order.
5. The order total is the sum of unit price times quantity over all lines. Two coffees at 3.00 cost 6.00.
6. Staff move an order forward one step at a time: pending, preparing, served, paid. Paid is final.

Every table and record belongs to a cafe; deleting a cafe deletes its tables, menu and orders.
