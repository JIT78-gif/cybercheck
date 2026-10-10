"use client";

import { useEffect, useState } from "react";

/** Seconds remaining before another code may be requested. */
export function useResendCooldown(initialSeconds: number) {
  const [remaining, setRemaining] = useState(initialSeconds);

  useEffect(() => {
    if (remaining <= 0) return;
    const t = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  return { remaining, restart: (seconds = 60) => setRemaining(seconds) };
}

export function useEmailDelivery() {
  const [mode, setMode] = useState<"smtp" | "console" | null>(null);
  useEffect(() => {
    fetch("/v1/auth/providers")
      .then((r) => r.json())
      .then((p: { emailDelivery: "smtp" | "console" }) => setMode(p.emailDelivery))
      .catch(() => setMode(null));
  }, []);
  return mode;
}
