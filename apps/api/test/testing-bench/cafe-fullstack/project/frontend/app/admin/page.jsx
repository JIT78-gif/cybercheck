"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { call } from "../../lib/api";

export default function Admin() {
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [tables, setTables] = useState([]);
  const [menu, setMenu] = useState([]);
  const [error, setError] = useState("");

  const load = useCallback(async (t) => {
    setTables(await call("/admin/tables", { token: t }));
    setMenu(await call("/admin/menu", { token: t }));
  }, []);

  useEffect(() => {
    const t = localStorage.getItem("cafe_token");
    if (!t) {
      router.push("/login");
      return;
    }
    setToken(t);
    load(t).catch(() => router.push("/login"));
  }, [router, load]);

  async function addTable(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await call("/admin/tables", { method: "POST", token, body: { number: f.get("number") } });
      e.currentTarget?.reset();
      await load(token);
    } catch (err) {
      setError(err.message);
    }
  }

  async function addItem(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await call("/admin/menu", { method: "POST", token, body: { name: f.get("name"), price: Number(f.get("price")) } });
      await load(token);
    } catch (err) {
      setError(err.message);
    }
  }

  if (!token) return <p>Loading</p>;
  return (
    <>
      <h1>Your cafe</h1>
      {error && <p className="error">{error}</p>}
      <section className="card">
        <h2>Tables</h2>
        <ul>
          {tables.map((t) => (
            <li key={t.id}>
              Table {t.number} (guest link: /c/{t.id})
            </li>
          ))}
        </ul>
        <form onSubmit={addTable}>
          <label htmlFor="number">Table number</label>
          <input id="number" name="number" required />
          <button type="submit">Add table</button>
        </form>
      </section>
      <section className="card">
        <h2>Menu</h2>
        <ul>
          {menu.map((m) => (
            <li key={m.id}>
              {m.name}: {m.price.toFixed(2)}
            </li>
          ))}
        </ul>
        <form onSubmit={addItem}>
          <label htmlFor="name">Item name</label>
          <input id="name" name="name" required />
          <span className="hint">Price</span>
          <input name="price" type="number" step="0.01" min="0" required />
          <button type="submit">Add item</button>
        </form>
      </section>
    </>
  );
}
