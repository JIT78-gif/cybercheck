const store = require("./store");

// Long-term assistant memory, scoped to the caller: recall returns only this user's own notes.
function remember(userId, note) {
  store.get().memory.push({ userId, note: String(note ?? ""), at: Date.now() });
}

function recall(userId) {
  return store.get().memory.filter((m) => m.userId === userId).map((m) => m.note);
}

module.exports = { remember, recall };
