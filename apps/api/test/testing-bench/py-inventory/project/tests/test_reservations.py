def reserve(client, quantity, order_id="SO-1", sku="WID-001"):
    return client.post(f"/items/{sku}/reservations", json={"quantity": quantity, "order_id": order_id})


def test_reservation_reduces_availability(client, widget):
    response = reserve(client, 4)
    assert response.status_code == 201
    assert response.json()["status"] == "active"

    item = client.get("/items/WID-001").json()
    assert item["reserved"] == 4
    assert item["available"] == 6


def test_cannot_reserve_more_than_on_hand(client, widget):
    response = reserve(client, 11)
    assert response.status_code == 409


def test_cannot_reserve_more_than_available(client, widget):
    assert reserve(client, 6, "SO-1").status_code == 201
    response = reserve(client, 6, "SO-2")
    assert response.status_code == 409
    assert client.get("/items/WID-001").json()["available"] == 4


def test_zero_quantity_is_rejected(client, widget):
    assert reserve(client, 0).status_code == 422


def test_reserving_unknown_item_returns_404(client):
    assert reserve(client, 1, sku="NOPE-1").status_code == 404


def test_release_restores_availability(client, widget):
    reservation = reserve(client, 3).json()
    assert client.delete(f"/reservations/{reservation['id']}").status_code == 204
    assert client.get("/items/WID-001").json()["available"] == 10
    assert client.delete(f"/reservations/{reservation['id']}").status_code == 409


def test_fulfil_consumes_stock(client, widget):
    reservation = reserve(client, 3).json()
    response = client.post(f"/reservations/{reservation['id']}/fulfil")
    assert response.status_code == 200
    assert response.json()["status"] == "fulfilled"

    item = client.get("/items/WID-001").json()
    assert item == {"sku": "WID-001", "name": "Widget", "on_hand": 7, "reserved": 0, "available": 7}
