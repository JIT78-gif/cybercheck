// A small fixed-window limiter for the sign-in and registration routes.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function loginLimiter(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    res.setHeader("retry-after", Math.ceil((entry.resetAt - now) / 1000));
    return res.status(429).json({ error: "too many attempts, try again later" });
  }
  next();
}

module.exports = { loginLimiter };
