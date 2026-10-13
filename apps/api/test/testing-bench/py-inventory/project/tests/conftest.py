import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture
def widget(client: TestClient) -> dict:
    response = client.post("/items", json={"sku": "WID-001", "name": "Widget", "on_hand": 10})
    assert response.status_code == 201
    return response.json()
