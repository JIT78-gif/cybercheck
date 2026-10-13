import { randomUUID } from "node:crypto";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  title: string;
  body: string;
  tags: string[];
}

export class NoteStore {
  private readonly notes = new Map<string, Note>();
  private readonly order = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: NoteInput): Note {
    const timestamp = this.now().toISOString();
    const note: Note = { id: randomUUID(), ...input, tags: [...input.tags], createdAt: timestamp, updatedAt: timestamp };
    this.notes.set(note.id, note);
    this.order.set(note.id, this.sequence++);
    return structuredClone(note);
  }

  list(tag?: string): Note[] {
    return [...this.notes.values()]
      .filter((note) => tag === undefined || note.tags.includes(tag))
      .sort((a, b) => (this.order.get(b.id) ?? 0) - (this.order.get(a.id) ?? 0))
      .map((note) => structuredClone(note));
  }

  get(id: string): Note | undefined {
    const note = this.notes.get(id);
    return note ? structuredClone(note) : undefined;
  }

  replace(id: string, input: NoteInput): Note | undefined {
    const existing = this.notes.get(id);
    if (!existing) return undefined;
    const updated: Note = { ...existing, ...input, tags: [...input.tags], updatedAt: this.now().toISOString() };
    this.notes.set(id, updated);
    return structuredClone(updated);
  }

  delete(id: string): boolean {
    this.order.delete(id);
    return this.notes.delete(id);
  }
}
