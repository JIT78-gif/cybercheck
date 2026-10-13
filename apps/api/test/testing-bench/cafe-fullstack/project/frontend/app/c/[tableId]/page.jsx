"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { call } from "../../../lib/api";

export default function Table() {
  const { tableId } = useParams();
  const [session, setSession] = useState(null);
  const [menu, setMenu] = useState([]);
  const [qty, setQty] = useState({});
  const [order, setOrder] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    call(`/customer/menu/${tableId}`).then(setMenu).catch((e) => setError(e.message));
  }, [tableId]);

  async function checkin(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const r = await call("/customer/checkin", { method: "POST", body: { table_id: Number(tableId), name: f.get("guest") } });
      setSession(r.session);
    } catch (err) {
      setError(err.message);
    }
  }

  async function place() {
    const items = Object.entries(qty)
      .filter(([, n]) => n > 0)
      .map(([id, n]) => ({ menu_item_id: Number(id), quantity: n }));
    try {
      setOrder(await call("/customer/orders", { method: "POST", session, body: { items } }));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <>
      <h1>Table {tableId}</h1>
      {error && <p className="error">{error}</p>}
      {!session ? (
        <form onSubmit={checkin} className="card">
          <label htmlFor="guest">Your name</label>
          <input id="guest" name="guest" required />
          <button type="submit">Check in</button>
        </form>
      ) : order ? (
        <section className="card">
          <h2>Order placed</h2>
          <p>
            Order #{order.id}, status {order.status}. Total: {order.total.toFixed(2)}
          </p>
        </section>
      ) : (
        <section className="card">
          <h2>Menu</h2>
          {menu.map((m) => (
            <div key={m.id}>
              <label htmlFor={`qty-${m.id}`}>
                {m.name} ({m.price.toFixed(2)})
              </label>
              <input id={`qty-${m.id}`} type="number" min="0" max="20" value={qty[m.id] ?? 0} onChange={(e) => setQty({ ...qty, [m.id]: Number(e.target.value) })} />
            </div>
          ))}
          <button type="button" onClick={place}>
            Place order
          </button>
        </section>
      )}
    </>
  );
}
