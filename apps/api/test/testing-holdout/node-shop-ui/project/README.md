# Corner Shop

A tiny shop: customers browse products, sign in and keep a cart; an admin adds products.

## Running it

Backend (needs Postgres, `DATABASE_URL`):

    cd backend && npm ci && npm start          # API on PORT (default 3001); creates its tables
    ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed   # creates the admin account

Frontend:

    cd frontend && npm ci && npm run build && npm run preview   # http://localhost:4173

Settings: `DATABASE_URL`, `PORT`, `FRONTEND_ORIGIN` (allowed browser origin, default
http://localhost:4173), `ADMIN_EMAIL`, `ADMIN_PASSWORD`; frontend `VITE_API_URL` (default http://localhost:3001).

## Rules

- Customers register (`POST /api/register`) with an email and a password of at least 8 characters, then sign in (`POST /api/login`) for a bearer token.
- Only the admin can add products (`POST /api/products`); prices are whole cents and never negative; SKUs are unique.
- A cart line's quantity is a whole number from 1 to 10, when adding an item and when changing its quantity.
- The cart total is the sum of price times quantity.
