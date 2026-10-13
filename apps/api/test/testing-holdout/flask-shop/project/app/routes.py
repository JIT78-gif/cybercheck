from __future__ import annotations

from flask import Blueprint, abort, current_app, jsonify, request

from .cart import Cart, CartStore
from .catalog import DISCOUNT_CODES, Catalog

bp = Blueprint("shop", __name__)

MAX_QUANTITY = 99


def catalog() -> Catalog:
    return current_app.extensions["catalog"]


def carts() -> CartStore:
    return current_app.extensions["carts"]


def load_cart(cart_id: str) -> Cart:
    cart = carts().get(cart_id)
    if cart is None:
        abort(404, description=f"cart {cart_id} not found")
    return cart


def cart_response(cart: Cart, status: int = 200):
    products = {p.sku: p for p in catalog().all()}
    return jsonify(cart.totals(products)), status


def json_object() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, description="request body must be a JSON object")
    return data


@bp.get("/health")
def health():
    return jsonify(status="ok")


@bp.get("/products")
def list_products():
    return jsonify([p.to_dict() for p in catalog().all()])


@bp.get("/products/<sku>")
def get_product(sku: str):
    product = catalog().get(sku)
    if product is None:
        abort(404, description=f"product {sku} not found")
    return jsonify(product.to_dict())


@bp.post("/cart")
def create_cart():
    return cart_response(carts().create(), 201)


@bp.get("/cart/<cart_id>")
def get_cart(cart_id: str):
    return cart_response(load_cart(cart_id))


@bp.post("/cart/<cart_id>/items")
def add_item(cart_id: str):
    cart = load_cart(cart_id)
    data = json_object()

    sku = data.get("sku")
    quantity = data.get("quantity", 1)
    if not isinstance(sku, str) or not sku:
        abort(400, description="sku is required")
    if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= MAX_QUANTITY:
        abort(400, description=f"quantity must be an integer from 1 to {MAX_QUANTITY}")
    if catalog().get(sku) is None:
        abort(404, description=f"product {sku} not found")

    new_quantity = cart.lines.get(sku, 0) + quantity
    if new_quantity > MAX_QUANTITY:
        abort(400, description=f"at most {MAX_QUANTITY} units per product")
    cart.lines[sku] = new_quantity
    return cart_response(cart)


@bp.delete("/cart/<cart_id>/items/<sku>")
def remove_item(cart_id: str, sku: str):
    cart = load_cart(cart_id)
    if sku not in cart.lines:
        abort(404, description=f"{sku} is not in the cart")
    del cart.lines[sku]
    return cart_response(cart)


@bp.post("/cart/<cart_id>/discount")
def apply_discount(cart_id: str):
    cart = load_cart(cart_id)
    data = json_object()

    code = data["code"].strip().upper()
    percent = DISCOUNT_CODES.get(code)
    if percent is None:
        abort(400, description=f"unknown discount code {code}")

    cart.discount_code = code
    cart.discount_percent = percent
    return cart_response(cart)
