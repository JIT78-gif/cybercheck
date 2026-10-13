def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.get_json() == {"status": "ok"}


def test_products_are_listed_by_sku(client):
    skus = [p["sku"] for p in client.get("/products").get_json()]
    assert skus == ["CAP-01", "MUG-01", "STK-01", "TEE-01"]


def test_get_product(client):
    response = client.get("/products/MUG-01")
    assert response.status_code == 200
    assert response.get_json() == {"sku": "MUG-01", "name": "Ceramic mug", "price_cents": 1200}


def test_unknown_product_returns_404(client):
    response = client.get("/products/NOPE")
    assert response.status_code == 404
    assert response.get_json()["error"] == "not_found"
