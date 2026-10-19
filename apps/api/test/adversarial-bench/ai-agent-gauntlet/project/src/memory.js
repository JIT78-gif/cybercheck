const store = require("./store");

// Long-term assistant memory. DELIBERATE (cross-tenant-memory-leak): recall ignores the caller id, so every caller
// reads every other user's and tenant's notes. A note written by one user also fuels the memory-poison chain, because
// a later privileged action (the admin summary) reads and acts on these notes.
function remember(userId, note) {
  store.get().memory.push({ userId, note: String(note ?? ""), at: Date.now() });
}

function recall(_userId) {
  return store.get().memory.map((m) => m.note);
}

module.exports = { remember, recall };
