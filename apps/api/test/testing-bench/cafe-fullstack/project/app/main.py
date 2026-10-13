import hashlib
import os
import secrets
from typing import List, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .db import connect, init_db

app = FastAPI(title="Cafe orders")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CAFE_CORS_ORIGINS", "http://localhost:3000").split(","), allow_methods=["*"], allow_headers=["*"])
init_db()

# Order status moves forward only: pending -> preparing -> served -> paid. Paid is final.
NEXT_STATUS = {"pending": "preparing", "preparing": "served", "served": "paid"}


def hash_password(password: str) -> str:
    return hashlib.sha256(("cafe:" + password).encode()).hexdigest()


class Activate(BaseModel):
    license_key: str = Field(min_length=8)
    email: str = Field(min_length=3)
    password: str = Field(min_length=8)


class Login(BaseModel):
    email: str
    password: str


class StaffIn(BaseModel):
    email: str = Field(min_length=3)
    password: str = Field(min_length=8)


class TableIn(BaseModel):
    number: str = Field(min_length=1, max_length=10)


class MenuItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    price: float = Field(ge=0)


class CheckIn(BaseModel):
    table_id: int
    name: str = Field(min_length=1, max_length=40)


class OrderLine(BaseModel):
    menu_item_id: int
    quantity: int = Field(gt=0, le=20)


class OrderIn(BaseModel):
    items: List[OrderLine] = Field(min_length=1)


class StatusIn(BaseModel):
    status: Literal["preparing", "served", "paid"]


def current_user(authorization: Optional[str] = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "sign in first")
    with connect() as conn:
        row = conn.execute("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", (authorization[7:],)).fetchone()
    if not row:
        raise HTTPException(401, "invalid token")
    return dict(row)


def require_admin(user=Depends(current_user)):
    if user["role"] != "admin":
        raise HTTPException(403, "admins only")
    return user


def customer_session(x_session: Optional[str] = Header(default=None)):
    if not x_session:
        raise HTTPException(401, "check in first")
    with connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE token = ? AND table_id IS NOT NULL", (x_session,)).fetchone()
    if not row:
        raise HTTPException(401, "unknown session")
    return dict(row)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/auth/activate", status_code=201)
def activate(body: Activate):
    """Creates the first admin of a cafe from its licence key (printed by seed.py)."""
    with connect() as conn:
        cafe = conn.execute("SELECT * FROM cafes WHERE license_key = ?", (body.license_key,)).fetchone()
        if not cafe:
            raise HTTPException(401, "unknown licence key")
        if conn.execute("SELECT 1 FROM users WHERE cafe_id = ? AND role = 'admin'", (cafe["id"],)).fetchone():
            raise HTTPException(409, "this cafe already has an admin")
        conn.execute("INSERT INTO users (cafe_id, email, password_hash, role) VALUES (?, ?, ?, 'admin')", (cafe["id"], body.email, hash_password(body.password)))
    return {"activated": True}


@app.post("/auth/login")
def login(body: Login):
    with connect() as conn:
        user = conn.execute("SELECT * FROM users WHERE email = ?", (body.email,)).fetchone()
        if not user or user["password_hash"] != hash_password(body.password):
            raise HTTPException(401, "wrong email or password")
        token = secrets.token_hex(16)
        conn.execute("INSERT INTO sessions (token, user_id) VALUES (?, ?)", (token, user["id"]))
    return {"token": token, "role": user["role"]}


@app.get("/admin/me")
def me(user=Depends(current_user)):
    return {"email": user["email"], "role": user["role"], "cafe_id": user["cafe_id"]}


@app.post("/admin/staff", status_code=201)
def create_staff(body: StaffIn, admin=Depends(require_admin)):
    with connect() as conn:
        try:
            cur = conn.execute("INSERT INTO users (cafe_id, email, password_hash, role) VALUES (?, ?, ?, 'staff')", (admin["cafe_id"], body.email, hash_password(body.password)))
        except Exception:
            raise HTTPException(409, "email already used")
    return {"id": cur.lastrowid, "email": body.email}


@app.get("/admin/tables")
def list_tables(user=Depends(current_user)):
    with connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM tables WHERE cafe_id = ? ORDER BY id", (user["cafe_id"],))]


@app.post("/admin/tables", status_code=201)
def create_table(body: TableIn, admin=Depends(require_admin)):
    with connect() as conn:
        try:
            cur = conn.execute("INSERT INTO tables (cafe_id, number) VALUES (?, ?)", (admin["cafe_id"], body.number))
        except Exception:
            raise HTTPException(409, "table number already used")
    return {"id": cur.lastrowid, "number": body.number}


@app.get("/admin/menu")
def list_menu(user=Depends(current_user)):
    with connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM menu_items WHERE cafe_id = ? ORDER BY id", (user["cafe_id"],))]


@app.post("/admin/menu", status_code=201)
def create_menu_item(body: MenuItemIn, admin=Depends(require_admin)):
    with connect() as conn:
        cur = conn.execute("INSERT INTO menu_items (cafe_id, name, price) VALUES (?, ?, ?)", (admin["cafe_id"], body.name, body.price))
    return {"id": cur.lastrowid, "name": body.name, "price": body.price}


@app.get("/customer/menu/{table_id}")
def customer_menu(table_id: int):
    with connect() as conn:
        table = conn.execute("SELECT * FROM tables WHERE id = ?", (table_id,)).fetchone()
        if not table:
            raise HTTPException(404, "no such table")
        return [dict(r) for r in conn.execute("SELECT id, name, price FROM menu_items WHERE cafe_id = ? ORDER BY id", (table["cafe_id"],))]


@app.post("/customer/checkin", status_code=201)
def checkin(body: CheckIn):
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM tables WHERE id = ?", (body.table_id,)).fetchone():
            raise HTTPException(404, "no such table")
        token = secrets.token_hex(16)
        conn.execute("INSERT INTO sessions (token, table_id, customer_name) VALUES (?, ?, ?)", (token, body.table_id, body.name))
    return {"session": token, "table_id": body.table_id}


@app.post("/customer/orders", status_code=201)
def place_order(body: OrderIn, session=Depends(customer_session)):
    """Places an order. The total is the sum of unit price x quantity over all lines (see README)."""
    with connect() as conn:
        cur = conn.execute("INSERT INTO orders (table_id) VALUES (?)", (session["table_id"],))
        order_id = cur.lastrowid
        total = 0.0
        for line in body.items:
            item = conn.execute("SELECT * FROM menu_items WHERE id = ?", (line.menu_item_id,)).fetchone()
            if not item:
                raise HTTPException(404, f"no menu item {line.menu_item_id}")
            conn.execute("INSERT INTO order_items (order_id, menu_item_id, quantity, unit_price) VALUES (?, ?, ?, ?)", (order_id, item["id"], line.quantity, item["price"]))
            total += item["price"]
        conn.execute("UPDATE orders SET total = ? WHERE id = ?", (round(total, 2), order_id))
    return get_order(order_id, session)


@app.get("/customer/orders/{order_id}")
def get_order(order_id: int, session=Depends(customer_session)):
    with connect() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ? AND table_id = ?", (order_id, session["table_id"])).fetchone()
        if not order:
            raise HTTPException(404, "no such order")
        lines = [dict(r) for r in conn.execute("SELECT menu_item_id, quantity, unit_price FROM order_items WHERE order_id = ?", (order_id,))]
    return {**dict(order), "items": lines}


@app.patch("/staff/orders/{order_id}")
def advance_order(order_id: int, body: StatusIn, user=Depends(current_user)):
    with connect() as conn:
        order = conn.execute("SELECT * FROM orders WHERE id = ?", (order_id,)).fetchone()
        if not order:
            raise HTTPException(404, "no such order")
        if NEXT_STATUS.get(order["status"]) != body.status:
            raise HTTPException(409, f"cannot move from {order['status']} to {body.status}")
        conn.execute("UPDATE orders SET status = ? WHERE id = ?", (body.status, order_id))
    return {"id": order_id, "status": body.status}
