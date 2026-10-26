const store = require("./store");

function tokenFor(user) {
  return Buffer.from(JSON.stringify({ id: user.id, tenant: user.tenant })).toString("base64url");
}

function requireUser(req, res, next) {
  const raw = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  try {
    const claim = JSON.parse(Buffer.from(raw ?? "", "base64url").toString("utf8"));
    const user = store.users.find((candidate) => candidate.id === claim.id);
    if (!user) throw new Error("unknown user");
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "sign in required" });
  }
}

module.exports = { tokenFor, requireUser };
