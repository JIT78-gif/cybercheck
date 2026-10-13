def add(client, cart_id, sku, quantity=1):
    return client.post(f"/cart/{cart_id}/items", json={"sku": sku, "quantity": quantity})


def test_new_cart_is_empty(client, cart_id):
    cart = client.get(f"/cart/{cart_id}").get_json()
    assert cart["items"] == []
    assert cart["total_cents"] == 0


def test_adding_items_updates_totals(client, cart_id):
    add(client, cart_id, "MUG-01", 2)
    response = add(client, cart_id, "STK-01", 1)
    assert response.status_code == 200
    cart = response.get_json()
    assert cart["subtotal_cents"] == 2 * 1200 + 499
    assert cart["total_cents"] == 2899


def test_adding_the_same_item_accumulates_quantity(client, cart_id):
    add(client, cart_id, "TEE-01", 1)
    cart = add(client, cart_id, "TEE-01", 2).get_json()
    assert cart["items"][0]["quantity"] == 3


def test_invalid_quantity_is_rejected(client, cart_id):
    assert add(client, cart_id, "MUG-01", 0).status_code == 400
    assert add(client, cart_id, "MUG-01", 100).status_code == 400
    assert add(client, cart_id, "MUG-01", "2").status_code == 400


def test_unknown_product_cannot_be_added(client, cart_id):
    assert add(client, cart_id, "NOPE", 1).status_code == 404


def test_unknown_cart_returns_404(client):
    assert client.get("/cart/does-not-exist").status_code == 404


def test_remove_item(client, cart_id):
    add(client, cart_id, "CAP-01", 1)
    response = client.delete(f"/cart/{cart_id}/items/CAP-01")
    assert response.status_code == 200
    assert response.get_json()["items"] == []


def test_discount_code_is_applied(client, cart_id):
    add(client, cart_id, "TEE-01", 2)
    response = client.post(f"/cart/{cart_id}/discount", json={"code": " welcome10 "})
    assert response.status_code == 200
    cart = response.get_json()
    assert cart["discount_code"] == "WELCOME10"
    assert cart["discount_cents"] == 500
    assert cart["total_cents"] == 4500


def test_unknown_discount_code_is_rejected(client, cart_id):
    response = client.post(f"/cart/{cart_id}/discount", json={"code": "FREE100"})
    assert response.status_code == 400
