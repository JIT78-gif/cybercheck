import type { Order, OrderStatus } from "./lifecycle.js";

export class OrderRepository {
  private readonly orders = new Map<string, Order>();

  save(order: Order): Order {
    this.orders.set(order.id, structuredClone(order));
    return structuredClone(order);
  }

  find(id: string): Order | undefined {
    const order = this.orders.get(id);
    return order ? structuredClone(order) : undefined;
  }

  list(status?: OrderStatus): Order[] {
    return [...this.orders.values()]
      .filter((order) => status === undefined || order.status === status)
      .map((order) => structuredClone(order));
  }
}
