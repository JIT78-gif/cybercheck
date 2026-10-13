import os
import tempfile

os.environ["CAFE_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient  # noqa: E402

from app.db import connect  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def make_admin():
    with connect() as conn:
        conn.execute("INSERT OR IGNORE INTO cafes (name, license_key) VALUES ('T', 'LIC-TEST-0001')")
    client.post("/auth/activate", json={"license_key": "LIC-TEST-0001", "email": "a@example.com", "password": "password123"})
    token = client.post("/auth/login", json={"email": "a@example.com", "password": "password123"}).json()["token"]
    return {"Authorization": f"Bearer {token}"}


def test_health():
    assert client.get("/health").json() == {"ok": True}


def test_activation_needs_a_known_licence():
    r = client.post("/auth/activate", json={"license_key": "LIC-NOPE-0000", "email": "x@example.com", "password": "password123"})
    assert r.status_code == 401


def test_admin_can_create_tables_and_menu():
    h = make_admin()
    assert client.post("/admin/tables", json={"number": "T1"}, headers=h).status_code == 201
    assert client.post("/admin/menu", json={"name": "Tea", "price": 2.5}, headers=h).status_code == 201
    assert any(m["name"] == "Tea" for m in client.get("/admin/menu", headers=h).json())


def test_customer_orders_one_item():
    h = make_admin()
    table = client.post("/admin/tables", json={"number": "T9"}, headers=h).json()
    item = client.post("/admin/menu", json={"name": "Coffee", "price": 3.0}, headers=h).json()
    session = client.post("/customer/checkin", json={"table_id": table["id"], "name": "Ana"}).json()["session"]
    order = client.post("/customer/orders", json={"items": [{"menu_item_id": item["id"], "quantity": 1}]}, headers={"X-Session": session}).json()
    assert order["total"] == 3.0
    assert order["status"] == "pending"


def test_orders_only_move_forward():
    h = make_admin()
    table = client.post("/admin/tables", json={"number": "T7"}, headers=h).json()
    item = client.post("/admin/menu", json={"name": "Cake", "price": 4.0}, headers=h).json()
    session = client.post("/customer/checkin", json={"table_id": table["id"], "name": "Bo"}).json()["session"]
    order = client.post("/customer/orders", json={"items": [{"menu_item_id": item["id"], "quantity": 1}]}, headers={"X-Session": session}).json()
    assert client.patch(f"/staff/orders/{order['id']}", json={"status": "served"}, headers=h).status_code == 409
    assert client.patch(f"/staff/orders/{order['id']}", json={"status": "preparing"}, headers=h).status_code == 200
