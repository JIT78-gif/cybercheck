export interface Note {
  id: number;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteInput {
  title: string;
  body: string;
  pinned: boolean;
}

export class NoteStore {
  private readonly notes = new Map<number, Note>();
  private nextId = 1;

  create(input: NoteInput): Note {
    const now = new Date().toISOString();
    const note: Note = { id: this.nextId++, ...input, createdAt: now, updatedAt: now };
    this.notes.set(note.id, note);
    return { ...note };
  }

  list(limit: number, offset: number): { items: Note[]; total: number } {
    const all = [...this.notes.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id);
    return { items: all.slice(offset, offset + limit).map((n) => ({ ...n })), total: all.length };
  }

  get(id: number): Note | undefined {
    const note = this.notes.get(id);
    return note ? { ...note } : undefined;
  }

  update(id: number, input: NoteInput): Note | undefined {
    const existing = this.notes.get(id);
    if (!existing) return undefined;
    const updated: Note = { ...existing, ...input, updatedAt: new Date().toISOString() };
    this.notes.set(id, updated);
    return { ...updated };
  }

  delete(id: number): boolean {
    return this.notes.delete(id);
  }
}
