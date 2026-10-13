export const ORDER_STATUSES = ["created", "paid", "shipped", "delivered", "cancelled"] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface StatusChange {
  from: OrderStatus;
  to: OrderStatus;
  at: string;
  note?: string;
}

export interface Order {
  id: string;
  customerId: string;
  totalCents: number;
  status: OrderStatus;
  history: StatusChange[];
  createdAt: string;
  updatedAt: string;
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Cannot move order from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

const TERMINAL: ReadonlySet<OrderStatus> = new Set(["delivered", "cancelled"]);

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.has(status);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (isTerminal(from)) return false;
  switch (to) {
    case "paid":
      return from === "created";
    case "shipped":
      return from !== "shipped";
    case "delivered":
      return from === "shipped";
    case "cancelled":
      return from === "created" || from === "paid";
    default:
      return false;
  }
}

export function createOrder(id: string, customerId: string, totalCents: number, now: Date): Order {
  const timestamp = now.toISOString();
  return {
    id,
    customerId,
    totalCents,
    status: "created",
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function transition(order: Order, to: OrderStatus, now: Date, note?: string): Order {
  if (!canTransition(order.status, to)) {
    throw new InvalidTransitionError(order.status, to);
  }
  const at = now.toISOString();
  const change: StatusChange = note ? { from: order.status, to, at, note } : { from: order.status, to, at };
  return {
    ...order,
    status: to,
    history: [...order.history, change],
    updatedAt: at,
  };
}
