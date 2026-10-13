"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call } from "../../lib/api";

export default function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const { token } = await call("/auth/login", { method: "POST", body: { email: f.get("email"), password: f.get("password") } });
      localStorage.setItem("cafe_token", token);
      router.push("/admin");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className="card">
      <h1>Sign in</h1>
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" required />
      {error && <p className="error">{error}</p>}
      <button type="submit">Sign in</button>
    </form>
  );
}
