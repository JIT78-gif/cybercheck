import os

from . import create_app


def main() -> None:
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "0.0.0.0")
    create_app().run(host=host, port=port)


if __name__ == "__main__":
    main()
