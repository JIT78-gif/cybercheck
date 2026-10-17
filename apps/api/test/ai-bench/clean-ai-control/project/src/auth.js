const crypto = require("node:crypto");
const { db } = require("./database");

const TOKEN_TTL_SECONDS = 60 * 60;

function tokenSecret() {
  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 32) throw new Error("TOKEN_SECRET must be set to at least 32 characters");
  return secret;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function sign(payload) {
  return crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
}

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(raw) {
  const [payload, signature] = String(raw).split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof claim.exp !== "number" || claim.exp < Date.now() / 1000) return null;
  return claim;
}

function requireUser(req, res, next) {
  const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const claim = raw ? readToken(raw) : null;
  const user = claim ? db.prepare("SELECT id, tenant, email, name FROM users WHERE id = ?").get(claim.sub) : null;
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

module.exports = { hashPassword, verifyPassword, issueToken, requireUser };
