const store = require("./store");

// Retrieve knowledge-base documents, scoped to the caller's tenant so one tenant never retrieves another's documents.
function retrieve(query, tenant) {
  const q = String(query ?? "").toLowerCase();
  return store.get().documents.filter((d) => d.tenant === tenant && (!q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q) || /ship|order|refund/.test(q)));
}

// Add a synthetic document only to the caller's own tenant. Its body is treated as data, never as instructions.
function addDocument(doc) {
  store.get().documents.push(doc);
  return doc;
}

module.exports = { retrieve, addDocument };
