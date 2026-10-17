# Semgrep test fixture for python.yml: every rule has a buggy line (ruleid) and a fixed one (ok).
import hashlib
import logging
import os
import pickle
import secrets
import subprocess
import traceback

import jwt
import requests
import yaml
from flask import Flask, Markup, jsonify, redirect, render_template_string, request, send_file
from flask_cors import CORS
from werkzeug.utils import secure_filename

app = Flask(__name__)
log = logging.getLogger(__name__)


@app.get("/users")
def users():
    name = request.args.get("name")
    # ruleid: cc.py.sql-injection, cc.py.sql-string-built
    cur.execute(f"SELECT * FROM users WHERE name = '{name}'")
    # ok: cc.py.sql-injection, cc.py.sql-string-built
    cur.execute("SELECT * FROM users WHERE name = %s", (name,))
    return jsonify([])


def report(day):
    # ruleid: cc.py.sql-string-built
    cur.execute("SELECT * FROM orders WHERE day = '%s'" % day)


@app.post("/convert")
def convert():
    # ruleid: cc.py.command-injection
    subprocess.run(f"convert {request.form['file']} out.png", shell=True)
    # ok: cc.py.command-injection
    subprocess.run(["convert", request.form["file"], "out.png"])
    return "ok"


def calc(expr):
    # ruleid: cc.py.code-injection
    return eval(expr)


def constant():
    # ok: cc.py.code-injection
    return eval("1 + 1")


@app.get("/hello")
def hello():
    # ruleid: cc.py.ssti
    return render_template_string("<p>" + request.args.get("name", "") + "</p>")


@app.get("/greet")
def greet():
    # ruleid: cc.py.xss
    return Markup("<b>" + request.args.get("name", "") + "</b>")


@app.get("/download")
def download():
    name = request.args.get("name")
    # ruleid: cc.py.path-traversal
    return send_file(os.path.join("/uploads", name))


@app.get("/download-safe")
def download_safe():
    name = secure_filename(request.args.get("name"))
    # ok: cc.py.path-traversal
    return send_file(os.path.join("/uploads", name))


@app.post("/preview")
def preview():
    # ruleid: cc.py.ssrf
    r = requests.get(request.json["url"])
    # ok: cc.py.ssrf
    s = requests.get("https://api.example.test/status")
    return jsonify(a=r.status_code, b=s.status_code)


@app.get("/go")
def go():
    # ruleid: cc.py.open-redirect
    return redirect(request.args.get("next"))


@app.get("/go-home")
def go_home():
    # ok: cc.py.open-redirect
    return redirect("/home")


def load(blob, text):
    # ruleid: cc.py.unsafe-deserialization
    a = pickle.loads(blob)
    # ruleid: cc.py.unsafe-deserialization
    b = yaml.load(text)
    # ok: cc.py.unsafe-deserialization
    c = yaml.load(text, Loader=yaml.SafeLoader)
    return a, b, c


def read_token(raw):
    # ruleid: cc.py.unverified-token
    claims = jwt.decode(raw, options={"verify_signature": False})
    # ok: cc.py.unverified-token
    checked = jwt.decode(raw, os.environ["JWT_SECRET"], algorithms=["HS256"])
    return claims, checked


@app.post("/login")
def login():
    # ruleid: cc.py.credentials-in-logs
    log.info("login attempt %s", request.form)
    # ok: cc.py.credentials-in-logs
    log.info("login attempt for %s", request.form.get("email"))
    return "ok"


@app.errorhandler(500)
def failed(e):
    # ruleid: cc.py.error-disclosure
    return traceback.format_exc()


@app.errorhandler(404)
def missing(e):
    # ok: cc.py.error-disclosure
    return jsonify(error="not found"), 404


# ruleid: cc.py.cors-any-origin
CORS(app)
# ok: cc.py.cors-any-origin
CORS(app, origins=["https://app.example.test"])

# ruleid: cc.py.weak-crypto
digest = hashlib.md5(b"x").hexdigest()
# ok: cc.py.weak-crypto
good = hashlib.sha256(b"x").hexdigest()
token = secrets.token_urlsafe(32)

if __name__ == "__main__":
    # ruleid: cc.py.debug-mode
    app.run(debug=True)
    # ok: cc.py.debug-mode
    app.run(debug=False)
