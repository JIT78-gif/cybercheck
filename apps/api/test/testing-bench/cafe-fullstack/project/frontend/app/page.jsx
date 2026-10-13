import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>Cafe orders</h1>
      <p>Set up your cafe, then let guests order from their table.</p>
      <ul>
        <li>
          <Link href="/activate">Activate your cafe</Link>
        </li>
        <li>
          <Link href="/login">Sign in</Link>
        </li>
      </ul>
    </>
  );
}
