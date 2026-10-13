def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_create_item_starts_fully_available(client):
    response = client.post("/items", json={"sku": "BOLT-12", "name": "Bolt M12", "on_hand": 250})
    assert response.status_code == 201
    assert response.json() == {
        "sku": "BOLT-12",
        "name": "Bolt M12",
        "on_hand": 250,
        "reserved": 0,
        "available": 250,
    }


def test_duplicate_sku_is_rejected(client, widget):
    response = client.post("/items", json={"sku": "WID-001", "name": "Other", "on_hand": 1})
    assert response.status_code == 409


def test_invalid_item_payload_is_rejected(client):
    assert client.post("/items", json={"sku": "x", "name": "Bad", "on_hand": 1}).status_code == 422
    assert client.post("/items", json={"sku": "NEG-1", "name": "Bad", "on_hand": -5}).status_code == 422
    assert client.post("/items", json={"sku": "EXT-1", "name": "Bad", "on_hand": 1, "price": 3}).status_code == 422


def test_unknown_item_returns_404(client):
    assert client.get("/items/NOPE-1").status_code == 404


def test_list_items_is_sorted_by_sku(client):
    for sku in ["C-300", "A-100", "B-200"]:
        client.post("/items", json={"sku": sku, "name": sku, "on_hand": 1})
    skus = [item["sku"] for item in client.get("/items").json()]
    assert skus == ["A-100", "B-200", "C-300"]


def test_receiving_stock_increases_on_hand(client, widget):
    response = client.post("/items/WID-001/stock", json={"delta": 5, "reason": "delivery"})
    assert response.status_code == 200
    assert response.json()["on_hand"] == 15


def test_write_off_cannot_go_below_reserved_units(client, widget):
    client.post("/items/WID-001/reservations", json={"quantity": 8, "order_id": "SO-1"})
    response = client.post("/items/WID-001/stock", json={"delta": -5, "reason": "damaged"})
    assert response.status_code == 409
    assert client.get("/items/WID-001").json()["on_hand"] == 10
