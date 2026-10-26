const store = require("./store");

// DELIBERATELY WEAK: unsigned bearer tokens that carry id, hotel and role in the clear. Anyone can decode one, change
// the role to "admin" and re-encode it, because nothing is signed or verified server-side (token-forgery).
function issueToken(user) {
  return Buffer.from(JSON.stringify({ id: user.id, hotel: user.hotel, role: user.role })).toString("base64url");
}

function currentUser(req) {
  const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return null;
  try {
    const claim = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
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

module.exports = { issueToken, currentUser, requireUser };
