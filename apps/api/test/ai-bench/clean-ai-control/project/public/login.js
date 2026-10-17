document.getElementById("login").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.getElementById("status");
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: document.getElementById("email").value, password: document.getElementById("password").value }),
  });
  if (!res.ok) {
    status.textContent = "Sign-in failed.";
    return;
  }
  sessionStorage.setItem("token", (await res.json()).token);
  location.href = "/assistant.html";
});
