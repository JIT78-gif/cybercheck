import crypto from "node:crypto";

/** Password hash used for stored accounts. */
export const hash = (password) => crypto.createHash("sha256").update(`shop:${password}`).digest("hex");
