const crypto = require("node:crypto");
const store = require("./store");

// HARDENED: signed bearer tokens. The payload is HMAC-signed with a server secret, so a tampered payload (for example a
// role changed to "admin") no longer verifies and is rejected. The secret is a synthetic test value.
const SECRET = "hotel-fixed-signing-secret-SYNTHETIC";
const sign = (payloadB64) => crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");

function issueToken(user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, hotel: user.hotel, role: user.role })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function currentUser(req) {
  const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  // Constant-time comparison; a forged or unsigned token fails here.
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return store.get().users.find((u) => u.id === claim.id) ? claim : null;
  } catch {
    return null;
  }
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  requireUser(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "administrators only" });
    next();
  });
}

module.exports = { issueToken, currentUser, requireUser, requireAdmin };
