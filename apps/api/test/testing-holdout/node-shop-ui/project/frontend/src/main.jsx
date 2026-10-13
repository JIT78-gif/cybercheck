import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useNavigate } from "react-router-dom";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";
const money = (cents) => `$${(cents / 100).toFixed(2)}`;

async function call(path, { method = "GET", body } = {}) {
  const token = localStorage.getItem("shop_token");
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `error ${res.status}`);
  return data;
}

function Products() {
  const [products, setProducts] = useState([]);
  const [note, setNote] = useState("");
  useEffect(() => {
    call("/api/products").then(setProducts).catch((e) => setNote(e.message));
  }, []);
  async function add(id) {
    try {
      await call("/api/cart/items", { method: "POST", body: { product_id: id, quantity: 1 } });
      setNote("Added to your cart");
    } catch (e) {
      setNote(e.message);
    }
  }
  return (
    <section>
      <h1>Products</h1>
      {note && <p role="status">{note}</p>}
      {products.length === 0 && <p>No products yet.</p>}
      <ul className="grid">
        {products.map((p) => (
          <li key={p.id} className="card">
            <img src="/box.svg" width="64" height="64" />
            <h2>{p.name}</h2>
            <p>{money(p.price_cents)}</p>
            <button type="button" onClick={() => add(p.id)}>
              Add to cart
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const { token } = await call("/api/login", { method: "POST", body: { email: f.get("email"), password: f.get("password") } });
      localStorage.setItem("shop_token", token);
      navigate("/cart");
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

function Cart() {
  const navigate = useNavigate();
  const [cart, setCart] = useState(null);
  useEffect(() => {
    if (!localStorage.getItem("shop_token")) {
      navigate("/login");
      return;
    }
    call("/api/cart").then(setCart).catch(() => navigate("/login"));
  }, [navigate]);
  if (!cart) return <p>Loading</p>;
  return (
    <section>
      <h1>Your cart</h1>
      {cart.items.length === 0 ? <p>Your cart is empty.</p> : null}
      <ul>
        {cart.items.map((i) => (
          <li key={i.id}>
            {i.name} x {i.quantity}: {money(i.price_cents * i.quantity)}
          </li>
        ))}
      </ul>
      <p>Total: {money(cart.total_cents)}</p>
    </section>
  );
}

function App() {
  return (
    <BrowserRouter>
      <nav className="nav">
        <Link to="/">Products</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/login">Sign in</Link>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Products />} />
          <Route path="/login" element={<Login />} />
          <Route path="/cart" element={<Cart />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")).render(<App />);
