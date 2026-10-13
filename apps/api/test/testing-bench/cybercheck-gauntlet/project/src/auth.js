const { users } = require("./store");

// Deliberately weak, unsigned bearer tokens for the benchmark.
function issueToken(user) {
  return Buffer.from(JSON.stringify({ id: user.id, role: user.role })).toString("base64url");
}

function currentUser(req) {
  const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return null;
  try {
    const claim = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return users.find((u) => u.id === claim.id) ? claim : null;
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

