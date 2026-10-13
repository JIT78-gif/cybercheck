"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { call } from "../../lib/api";

export default function Activate() {
  const router = useRouter();
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await call("/auth/activate", { method: "POST", body: { license_key: f.get("license_key"), email: f.get("email"), password: f.get("password") } });
      router.push("/login");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className="card">
      <h1>Activate your cafe</h1>
      <label htmlFor="license_key">Licence key</label>
      <input id="license_key" name="license_key" required />
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" required />
      <label htmlFor="password">Password</label>
      <input id="password" name="password" type="password" minLength={8} required />
      {error && <p className="error">{error}</p>}
      <button type="submit">Activate</button>
    </form>
  );
}
