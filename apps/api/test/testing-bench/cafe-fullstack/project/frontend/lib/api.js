export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function call(path, { method = "GET", body, token, session } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (session) headers["x-session"] = session;
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail ? String(typeof data.detail === "string" ? data.detail : "invalid input") : `error ${res.status}`);
  return data;
}
