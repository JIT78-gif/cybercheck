from flask import Flask, jsonify
from werkzeug.exceptions import HTTPException

from .cart import CartStore
from .catalog import Catalog


def create_app(catalog: Catalog | None = None) -> Flask:
    app = Flask(__name__)
    app.json.sort_keys = False
    app.extensions["catalog"] = catalog or Catalog.default()
    app.extensions["carts"] = CartStore()

    from .routes import bp

    app.register_blueprint(bp)

    @app.errorhandler(HTTPException)
    def http_error(exc: HTTPException):
        return jsonify(error=exc.name.lower().replace(" ", "_"), message=exc.description), exc.code

    return app
