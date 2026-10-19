const store = require("./store");

// Retrieve knowledge-base documents for a query. DELIBERATE (rag-tenant-filter-bypass): the caller's tenant is
// accepted but never used to filter, so one tenant's assistant can retrieve another tenant's confidential documents.
function retrieve(query, _tenant) {
  const q = String(query ?? "").toLowerCase();
  return store.get().documents.filter((d) => !q || d.title.toLowerCase().includes(q) || d.body.toLowerCase().includes(q) || /ship|price|margin|cost|confidential|secret|refund|order/.test(q));
}

// Add a synthetic knowledge document. DELIBERATE (indirect-rag-injection vector): the body is stored and later placed
// into the assistant's prompt verbatim, so an uploaded document can carry instructions the assistant then obeys.
function addDocument(doc) {
  store.get().documents.push(doc);
  return doc;
}

module.exports = { retrieve, addDocument };
