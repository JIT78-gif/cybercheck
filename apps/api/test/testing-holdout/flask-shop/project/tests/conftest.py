import pytest

from app import create_app


@pytest.fixture
def client():
    app = create_app()
    app.config.update(TESTING=True)
    return app.test_client()


@pytest.fixture
def cart_id(client):
    response = client.post("/cart")
    assert response.status_code == 201
    return response.get_json()["id"]
