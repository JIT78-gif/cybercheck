import os

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("app.main:app", host=host, port=port)


if __name__ == "__main__":
    main()
