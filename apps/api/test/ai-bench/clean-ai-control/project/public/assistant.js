let conversationId = null;

document.getElementById("ask").addEventListener("submit", async (event) => {
  event.preventDefault();
  const answer = document.getElementById("answer");
  const sources = document.getElementById("sources");
  const res = await fetch("/api/assistant", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionStorage.getItem("token") ?? ""}` },
    body: JSON.stringify({ message: document.getElementById("message").value, conversationId }),
  });
  const data = await res.json();
  // Model output is text, never markup.
  answer.textContent = res.ok ? data.reply : data.error;
  sources.replaceChildren(...(data.citations ?? []).map((c) => Object.assign(document.createElement("li"), { textContent: c.title })));
  if (res.ok) conversationId = data.conversationId;
});
