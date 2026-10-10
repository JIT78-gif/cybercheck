import type { Node } from "web-tree-sitter";
import type { DomainType, EnumDef, Entity, Evidence } from "@cybercheck/contracts";
import { line, stringValue, walk, type Parsed } from "../parse.ts";
import type { Ctx } from "./context.ts";

type Field = Entity["fields"][number];
type Relation = Entity["relations"][number];
/** Entities and types before ids and claim status are assigned in analyzeDataModel. */
type EntityDraft = Omit<Entity, "id" | "status">;
type TypeDraft = Omit<DomainType, "id">;

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

// ---------- Prisma ----------

const PRISMA_SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes", "Unsupported"]);

function prisma(path: string, text: string, entities: EntityDraft[], enums: EnumDef[]) {
  for (const m of text.matchAll(/^\s*enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const values = m[2]!.split("\n").map((l) => l.replace(/\/\/.*$/, "").trim().split(/\s/)[0]!).filter((v) => /^\w+$/.test(v));
    enums.push({ name: m[1]!, values, evidence: { path, line: lineAt(text, m.index!) } });
  }
  const modelNames = new Set([...text.matchAll(/^\s*model\s+(\w+)/gm)].map((m) => m[1]!));
  for (const m of text.matchAll(/^\s*model\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const fields: Field[] = [];
    const relations: Relation[] = [];
    let table: string | null = null;
    for (const raw of m[2]!.split("\n")) {
      const l = raw.replace(/\/\/.*$/, "").trim();
      if (!l) continue;
      const map = l.match(/^@@map\(\s*"([^"]+)"/);
      if (map) table = map[1]!;
      if (l.startsWith("@@")) continue;
      const f = l.match(/^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/);
      if (!f) continue;
      const [, name, type, list, opt, attrs] = f as unknown as [string, string, string, string | undefined, string | undefined, string];
      if (modelNames.has(type)) {
        relations.push({ to: type, kind: list ? "many" : "one", field: name });
        continue;
      }
      const ref = attrs.match(/@relation\([^)]*references:\s*\[(\w+)\]/);
      fields.push({
        name,
        type: `${type}${list ? "[]" : ""}`,
        nullable: Boolean(opt) || undefined,
        primaryKey: /@id\b/.test(attrs) || undefined,
        unique: /@unique\b/.test(attrs) || undefined,
        references: ref ? ref[1] : undefined,
      });
      if (!PRISMA_SCALARS.has(type) && !list) {
        // enum-typed field: keep the type name
      }
    }
    entities.push({ name: m[1]!, table, source: "prisma", fields, relations, evidence: { path, line: lineAt(text, m.index!) } });
  }
}

// ---------- SQL (schema files, migrations, and SQL inside code strings) ----------

/** Column added later by a migration: applied after all tables are known. */
type AddColumn = { table: string; column: string; ddl: string; evidence: Evidence };

const SQL_KEYWORDS = /^(primary|unique|constraint|check|key|index|foreign|exclude)\b/i;

/** Replace comments with spaces so positions and line numbers stay the same. */
function blankSqlComments(text: string) {
  return text.replace(/--[^\n]*/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

/** Split a column list on top-level commas (not inside parentheses or quotes). */
function splitColumns(body: string) {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** The table body between the opening parenthesis and its matching close. */
function tableBody(text: string, open: number) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

function parseColumn(raw: string): { field: Field; ref: string | null } | null {
  const l = raw.trim().replace(/\s+/g, " ");
  if (!l || SQL_KEYWORDS.test(l)) return null;
  const c = l.match(/^["`[]?(\w+)["`\]]?\s+([\w]+(?:\s*\([^)]*\))?(?:\[\])?)(.*)$/i);
  if (!c) return null;
  const rest = c[3] ?? "";
  const ref = rest.match(/references\s+["`]?(?:\w+["`]?\.["`]?)?(\w+)/i)?.[1] ?? null;
  return {
    field: {
      name: c[1]!,
      type: c[2]!.toLowerCase(),
      nullable: !/not\s+null|primary\s+key/i.test(rest) || undefined,
      primaryKey: /primary\s+key/i.test(rest) || undefined,
      unique: /\bunique\b/i.test(rest) || undefined,
      references: ref ?? undefined,
    },
    ref,
  };
}

/**
 * CREATE TABLE and ALTER TABLE ... ADD COLUMN statements. `lineBase` is the line where `text`
 * starts in its file (for SQL embedded in code strings).
 */
function sql(path: string, rawText: string, entities: EntityDraft[], adds: AddColumn[], lineBase = 1) {
  const text = blankSqlComments(rawText);
  const at = (i: number) => lineBase + lineAt(text, i) - 1;
  for (const m of text.matchAll(/create\s+(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?["`[]?(?:\w+["`\]]?\.["`[]?)?(\w+)["`\]]?\s*\(/gi)) {
    const name = m[1]!;
    const body = tableBody(text, m.index! + m[0].length - 1);
    if (body == null) continue;
    const fields: Field[] = [];
    const relations: Relation[] = [];
    for (const raw of splitColumns(body)) {
      const fk = raw.match(/foreign\s+key\s*\(\s*["`]?(\w+)["`]?\s*\)\s*references\s+["`]?(?:\w+["`]?\.["`]?)?(\w+)/i);
      if (fk) {
        relations.push({ to: fk[2]!, kind: "one", field: fk[1]! });
        const f = fields.find((x) => x.name === fk[1]);
        if (f) f.references = fk[2]!;
        continue;
      }
      const col = parseColumn(raw);
      if (!col) continue;
      fields.push(col.field);
      if (col.ref) relations.push({ to: col.ref, kind: "one", field: col.field.name });
    }
    if (entities.some((e) => e.source === "sql" && e.name.toLowerCase() === name.toLowerCase())) continue; // first full definition wins
    entities.push({ name, table: name, source: "sql", fields, relations, evidence: { path, line: at(m.index!) } });
  }
  for (const m of text.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?["`[]?(?:\w+["`\]]?\.["`[]?)?(\w+)["`\]]?\s+add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?([^;]+)/gi)) {
    const col = parseColumn(m[2]!);
    if (col) adds.push({ table: m[1]!, column: col.field.name, ddl: m[2]!.trim().slice(col.field.name.length).trim(), evidence: { path, line: at(m.index!) } });
  }
}

/** SQL written inside string or template literals in TS/JS/Python (e.g. db.exec(`CREATE TABLE ...`)). */
function embeddedSql(p: Parsed, entities: EntityDraft[], adds: AddColumn[]) {
  if (!/create\s+(?:temp\w*\s+)?table|alter\s+table/i.test(p.text)) return;
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "template_string" && n.type !== "string") continue;
    if (!/create\s+(?:temp\w*\s+)?table|alter\s+table/i.test(n.text)) continue;
    // Substitutions like ${table} stay as text; they only matter inside names we can't resolve anyway.
    sql(p.path, n.text, entities, adds, line(n));
  }
}

/** Migration helpers called with string literals: addColumnIfMissing(db, "leads", "notes", "TEXT"). */
function migrationHelpers(p: Parsed, adds: AddColumn[]) {
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "call_expression" && n.type !== "call") continue;
    const fn = n.childForFieldName("function")?.text ?? "";
    if (!/(add|ensure|create)_?\w*column/i.test(fn.split(".").at(-1) ?? "")) continue;
    const strings = (n.childForFieldName("arguments")?.namedChildren ?? []).map((a) => stringValue(a)).filter((s): s is string => s != null);
    if (strings.length < 3) continue;
    const [table, column, ddl] = strings.slice(-3) as [string, string, string];
    if (/^\w+$/.test(table) && /^\w+$/.test(column)) adds.push({ table, column, ddl, evidence: { path: p.path, line: line(n) } });
  }
}

function applyAddedColumns(entities: EntityDraft[], adds: AddColumn[]) {
  for (const a of adds) {
    const e = entities.find((x) => (x.table ?? x.name).toLowerCase() === a.table.toLowerCase());
    if (!e || e.fields.some((f) => f.name === a.column)) continue;
    const col = parseColumn(`${a.column} ${a.ddl || "unknown"}`);
    if (col) e.fields.push({ ...col.field, addedBy: a.evidence });
  }
}

// Credentials and data about people. Used for data-flow and privacy checks.
const SECRET_FIELD = /(password|passwd|pwd_hash|secret|token|api_?key|private_?key|refresh_?token|access_?token|session_?id|otp|mfa)/i;
const PERSONAL_FIELD = /(e_?mail|phone|mobile|whatsapp|first_?name|last_?name|full_?name|display_?name|^name$|_name$|username|address|birth|dob|ssn|passport|national_?id|ip_?address|transcript|audio|recording|location|latitude|longitude|^text$|message|social_?handle)/i;

export function fieldSensitivity(name: string): Entity["fields"][number]["sensitivity"] {
  if (SECRET_FIELD.test(name)) return "secret";
  if (PERSONAL_FIELD.test(name)) return "personal";
  return "none";
}

// ---------- Drizzle ----------

function drizzle(p: Parsed, entities: EntityDraft[], enums: EnumDef[]) {
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "variable_declarator") continue;
    const id = n.childForFieldName("name")?.text;
    const v = n.childForFieldName("value");
    if (!id || v?.type !== "call_expression") continue;
    const fn = v.childForFieldName("function")?.text ?? "";
    const args = (v.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [];
    if (/^(pgEnum|mysqlEnum)$/.test(fn)) {
      const values = args[1]?.namedChildren.map((c) => stringValue(c) ?? "").filter(Boolean) ?? [];
      enums.push({ name: stringValue(args[0]) ?? id, values, evidence: { path: p.path, line: line(n) } });
      continue;
    }
    if (!/^(pgTable|mysqlTable|sqliteTable)$/.test(fn)) continue;
    const table = stringValue(args[0]);
    const cols = args[1];
    if (!table || cols?.type !== "object") continue;
    const fields: Field[] = [];
    const relations: Relation[] = [];
    for (const pair of cols.namedChildren) {
      if (pair?.type !== "pair") continue;
      const name = pair.childForFieldName("key")?.text.replace(/['"]/g, "") ?? "";
      const t = pair.childForFieldName("value")?.text ?? "";
      const base = t.match(/^(\w+)\(/)?.[1] ?? "unknown";
      const ref = t.match(/\.references\(\s*\(\)\s*=>\s*(\w+)\.(\w+)/);
      if (ref) relations.push({ to: ref[1]!, kind: "one", field: name });
      fields.push({
        name,
        type: base,
        nullable: !/\.notNull\(\)|\.primaryKey\(\)/.test(t) || undefined,
        primaryKey: /\.primaryKey\(\)/.test(t) || undefined,
        unique: /\.unique\(\)/.test(t) || undefined,
        references: ref ? `${ref[1]}.${ref[2]}` : undefined,
      });
    }
    entities.push({ name: id, table, source: "drizzle", fields, relations, evidence: { path: p.path, line: line(n) } });
  }
}

// ---------- TypeORM / Mongoose ----------

function typeorm(p: Parsed, entities: EntityDraft[]) {
  if (!/@Entity\(/.test(p.text)) return;
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "class_declaration") continue;
    const text = n.parent?.type === "export_statement" ? n.parent.text : n.text;
    if (!/@Entity\(/.test(text)) continue;
    const name = n.childForFieldName("name")?.text ?? "Entity";
    const table = text.match(/@Entity\(\s*["'](\w+)["']/)?.[1] ?? null;
    const fields: Field[] = [];
    const relations: Relation[] = [];
    for (const m of text.matchAll(/@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|ManyToOne|OneToMany|OneToOne|ManyToMany)\(([^)]*)\)[\s\S]*?(\w+)[!?]?\s*:\s*([\w<>[\]| ]+)/g)) {
      const [, deco, , prop, type] = m as unknown as [string, string, string, string, string];
      if (/ManyToOne|OneToOne/.test(deco)) relations.push({ to: type.trim().replace(/[[\]]/g, ""), kind: "one", field: prop });
      else if (/OneToMany|ManyToMany/.test(deco)) relations.push({ to: type.trim().replace(/[[\]]|\bArray<|>/g, ""), kind: "many", field: prop });
      else fields.push({ name: prop, type: type.trim(), primaryKey: /Primary/.test(deco) || undefined, nullable: /nullable:\s*true/.test(m[2]!) || undefined, unique: /unique:\s*true/.test(m[2]!) || undefined });
    }
    entities.push({ name, table, source: "typeorm", fields, relations, evidence: { path: p.path, line: line(n) } });
  }
}

function mongoose(p: Parsed, entities: EntityDraft[]) {
  if (!/mongoose/.test(p.text)) return;
  const schemas = new Map<string, { fields: Field[]; relations: Relation[]; line: number }>();
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "variable_declarator") continue;
    const id = n.childForFieldName("name")?.text;
    const v = n.childForFieldName("value");
    if (!id || v?.type !== "new_expression" || !/Schema$/.test(v.childForFieldName("constructor")?.text ?? "")) continue;
    const obj = v.childForFieldName("arguments")?.namedChildren[0];
    if (obj?.type !== "object") continue;
    const fields: Field[] = [];
    const relations: Relation[] = [];
    for (const pair of obj.namedChildren) {
      if (pair?.type !== "pair") continue;
      const name = pair.childForFieldName("key")?.text.replace(/['"]/g, "") ?? "";
      const t = pair.childForFieldName("value")?.text ?? "";
      const ref = t.match(/ref:\s*["'](\w+)["']/);
      if (ref) relations.push({ to: ref[1]!, kind: t.trim().startsWith("[") ? "many" : "one", field: name });
      fields.push({ name, type: t.match(/type:\s*([\w.]+)/)?.[1] ?? t.match(/^\[?\s*([\w.]+)/)?.[1] ?? "Mixed", unique: /unique:\s*true/.test(t) || undefined, nullable: !/required:\s*true/.test(t) || undefined });
    }
    schemas.set(id, { fields, relations, line: line(n) });
  }
  for (const m of p.text.matchAll(/model\(\s*["'](\w+)["']\s*,\s*(\w+)/g)) {
    const s = schemas.get(m[2]!);
    if (s) entities.push({ name: m[1]!, table: null, source: "mongoose", fields: s.fields, relations: s.relations, evidence: { path: p.path, line: s.line } });
  }
}

// ---------- SQLAlchemy / Django / Pydantic / dataclasses ----------

function pyClasses(p: Parsed, entities: EntityDraft[], types: TypeDraft[], enums: EnumDef[]) {
  for (const n of walk(p.tree.rootNode)) {
    if (n.type !== "class_definition") continue;
    const name = n.childForFieldName("name")?.text ?? "";
    const bases = n.childForFieldName("superclasses")?.text ?? "";
    const body = n.childForFieldName("body");
    if (!body) continue;
    const decorated = n.parent?.type === "decorated_definition" ? n.parent.text.split("\n")[0]! : "";
    const isDjango = /models\.Model\b/.test(bases);
    const isSqlA = /\b(Base|DeclarativeBase|db\.Model|SQLModel)\b/.test(bases) && /(Column\(|mapped_column\(|__tablename__|Field\()/.test(body.text);
    const isPydantic = /\b(BaseModel|BaseSettings|Schema)\b/.test(bases) && !isSqlA;
    const isEnum = /\b(Enum|IntEnum|StrEnum|TextChoices|IntegerChoices)\b/.test(bases);
    const isDataclass = /@dataclass/.test(decorated);
    const isTypedDict = /\bTypedDict\b/.test(bases);

    const assigns: Array<{ name: string; value: string; annotation: string }> = [];
    for (const st of body.namedChildren) {
      const a = st?.type === "expression_statement" ? st.namedChildren[0] : null;
      if (a?.type !== "assignment") continue;
      const left = a.childForFieldName("left")?.text ?? "";
      if (!/^\w+$/.test(left)) continue;
      assigns.push({ name: left, value: a.childForFieldName("right")?.text ?? "", annotation: a.childForFieldName("type")?.text ?? "" });
    }

    if (isEnum) {
      enums.push({ name, values: assigns.map((a) => a.name), evidence: { path: p.path, line: line(n) } });
      continue;
    }
    if (isDjango || isSqlA) {
      const fields: Field[] = [];
      const relations: Relation[] = [];
      let table: string | null = null;
      for (const a of assigns) {
        if (a.name === "__tablename__") {
          table = a.value.replace(/["']/g, "");
          continue;
        }
        if (a.name.startsWith("_") || a.name === "Meta" || a.name === "objects") continue;
        const fk = a.value.match(/(?:ForeignKey|OneToOneField)\(\s*["']?([\w.]+)["']?/) ?? a.value.match(/ForeignKey\(\s*["'](\w+)\.\w+["']/);
        const m2m = a.value.match(/ManyToManyField\(\s*["']?([\w.]+)["']?/);
        const rel = a.value.match(/relationship\(\s*["']?(\w+)["']?/) ?? a.annotation.match(/Mapped\[\s*(?:list\[|List\[)?["']?(\w+)["']?/);
        if (m2m) relations.push({ to: m2m[1]!.split(".").at(-1)!, kind: "many", field: a.name });
        else if (fk && !/Column|mapped_column/.test(a.value.split("(")[0]!)) relations.push({ to: fk[1]!.split(".").at(-1)!, kind: "one", field: a.name });
        if (/relationship\(/.test(a.value) && rel) {
          relations.push({ to: rel[1]!, kind: /list\[|List\[|uselist=True/.test(a.annotation + a.value) ? "many" : "one", field: a.name });
          continue;
        }
        const type = a.value.match(/(?:models\.)?(\w+Field)\(/)?.[1] ?? a.value.match(/(?:Column|mapped_column)\(\s*(\w+)/)?.[1] ?? a.annotation.replace(/^Mapped\[(.*)\]$/, "$1");
        if (!type) continue;
        const sqlFk = a.value.match(/ForeignKey\(\s*["'](\w+)\.(\w+)["']/);
        if (sqlFk && /Column|mapped_column/.test(a.value)) relations.push({ to: sqlFk[1]!, kind: "one", field: a.name });
        fields.push({
          name: a.name,
          type,
          primaryKey: /primary_key\s*=\s*True/.test(a.value) || undefined,
          unique: /unique\s*=\s*True/.test(a.value) || undefined,
          nullable: /null\s*=\s*True|nullable\s*=\s*True|Optional\[/.test(a.value + a.annotation) || undefined,
          references: sqlFk ? `${sqlFk[1]}.${sqlFk[2]}` : undefined,
        });
      }
      entities.push({ name, table, source: isDjango ? "django" : "sqlalchemy", fields, relations, evidence: { path: p.path, line: line(n) } });
      continue;
    }
    if (isPydantic || isDataclass || isTypedDict) {
      const fields: TypeDraft["fields"] = [];
      for (const st of body.namedChildren) {
        const a = st?.type === "expression_statement" ? st.namedChildren[0] : null;
        if (a?.type === "assignment" && a.childForFieldName("type")) fields.push({ name: a.childForFieldName("left")!.text, type: a.childForFieldName("type")!.text });
        if (a?.type === "type") fields.push({ name: a.text, type: "" });
      }
      // annotated-only fields parse as "expression_statement > type"? tree-sitter-python uses assignment with no right side
      types.push({ name, kind: isPydantic ? "pydantic" : isDataclass ? "dataclass" : "typeddict", fields, extends: bases.replace(/[()]/g, "").split(",").map((s) => s.trim()).filter(Boolean), evidence: { path: p.path, line: line(n) } });
    }
  }
}

// ---------- TypeScript domain types ----------

function tsTypes(p: Parsed, types: TypeDraft[], enums: EnumDef[]) {
  for (const n of walk(p.tree.rootNode)) {
    if (n.type === "interface_declaration") {
      const body = n.childForFieldName("body");
      const fields = (body?.namedChildren ?? [])
        .filter((c) => c?.type === "property_signature")
        .map((c) => ({ name: c!.childForFieldName("name")?.text ?? "", type: (c!.childForFieldName("type")?.text ?? "").replace(/^:\s*/, "").slice(0, 80) }));
      const ext = n.namedChildren.find((c) => c?.type === "extends_type_clause")?.namedChildren.map((c) => c!.text) ?? [];
      types.push({ name: n.childForFieldName("name")?.text ?? "", kind: "interface", fields, extends: ext, evidence: { path: p.path, line: line(n) } });
    } else if (n.type === "type_alias_declaration") {
      const value = n.childForFieldName("value");
      const name = n.childForFieldName("name")?.text ?? "";
      if (value?.type === "object_type") {
        const fields = value.namedChildren
          .filter((c) => c?.type === "property_signature")
          .map((c) => ({ name: c!.childForFieldName("name")?.text ?? "", type: (c!.childForFieldName("type")?.text ?? "").replace(/^:\s*/, "").slice(0, 80) }));
        types.push({ name, kind: "type", fields, extends: [], evidence: { path: p.path, line: line(n) } });
      } else if (value?.type === "union_type" && /^(\s*\|?\s*["'][\w-]+["']\s*)+$/.test(value.text)) {
        enums.push({ name, values: [...value.text.matchAll(/["']([\w-]+)["']/g)].map((m) => m[1]!), evidence: { path: p.path, line: line(n) } });
      }
    } else if (n.type === "enum_declaration") {
      const values = (n.childForFieldName("body")?.namedChildren ?? []).map((c) => (c?.type === "enum_assignment" ? c.childForFieldName("name")?.text : c?.text) ?? "").filter(Boolean);
      enums.push({ name: n.childForFieldName("name")?.text ?? "", values, evidence: { path: p.path, line: line(n) } });
    } else if (n.type === "class_declaration" && !/@Entity\(/.test(n.parent?.text ?? n.text)) {
      const body = n.childForFieldName("body");
      const fields = (body?.namedChildren ?? [])
        .filter((c) => c?.type === "public_field_definition")
        .map((c) => ({ name: c!.childForFieldName("name")?.text ?? "", type: (c!.childForFieldName("type")?.text ?? "").replace(/^:\s*/, "").slice(0, 80) }));
      if (fields.length >= 2) {
        const ext = n.namedChildren.find((c) => c?.type === "class_heritage")?.text.replace(/^extends\s+/, "").split(/\s+implements\s+|,/).map((s) => s.trim()).filter(Boolean) ?? [];
        types.push({ name: n.childForFieldName("name")?.text ?? "", kind: "class", fields, extends: ext, evidence: { path: p.path, line: line(n) } });
      }
    } else if (n.type === "variable_declarator") {
      // const UserSchema = z.object({ ... })
      const v = n.childForFieldName("value");
      if (v?.type !== "call_expression" || !/^z\.object$/.test(v.childForFieldName("function")?.text ?? "")) continue;
      const obj = v.childForFieldName("arguments")?.namedChildren[0];
      if (obj?.type !== "object") continue;
      const fields = obj.namedChildren
        .filter((c) => c?.type === "pair")
        .map((c) => ({ name: c!.childForFieldName("key")?.text.replace(/['"]/g, "") ?? "", type: (c!.childForFieldName("value")?.text ?? "").replace(/^z\./, "").slice(0, 80) }));
      types.push({ name: n.childForFieldName("name")?.text ?? "", kind: "zod", fields, extends: [], evidence: { path: p.path, line: line(n) } });
    }
  }
}

export function analyzeDataModel(ctx: Ctx) {
  const entities: EntityDraft[] = [];
  const enums: EnumDef[] = [];
  const types: TypeDraft[] = [];
  const adds: AddColumn[] = [];
  for (const [path, f] of ctx.src.files) {
    if (ctx.isTest(path)) continue;
    if (path.endsWith(".prisma")) prisma(path, f.text, entities, enums);
    else if (path.endsWith(".sql")) sql(path, f.text, entities, adds);
  }
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    embeddedSql(p, entities, adds);
    migrationHelpers(p, adds);
    if (p.lang === "python") pyClasses(p, entities, types, enums);
    else {
      if (/drizzle-orm/.test(p.text)) drizzle(p, entities, enums);
      typeorm(p, entities);
      mongoose(p, entities);
      tsTypes(p, types, enums);
    }
  }
  applyAddedColumns(entities, adds);
  // Prefer ORM definitions over raw SQL for the same table (migrations often mirror the ORM).
  const ormTables = new Set(entities.filter((e) => e.source !== "sql").map((e) => (e.table ?? e.name).toLowerCase()));
  const deduped = entities.filter((e) => e.source !== "sql" || !ormTables.has((e.table ?? e.name).toLowerCase()));
  const sources = [...new Set(deduped.map((e) => e.source))];
  const finalEntities: Entity[] = deduped.slice(0, 200).map((e) => ({
    ...e,
    id: `entity:${e.source}:${(e.table ?? e.name).toLowerCase()}`,
    status: "observed",
    fields: e.fields.map((f) => ({ ...f, sensitivity: fieldSensitivity(f.name) })),
  }));

  // Types that describe domain data, most field-rich first. Same-named types in different files stay separate.
  const ranked = types.filter((t) => t.name && t.fields.length > 0).sort((a, b) => b.fields.length - a.fields.length);
  const domainTypes: DomainType[] = ranked.slice(0, 120).map((t) => ({ ...t, id: `${t.evidence.path}#${t.name}` }));
  return { dataModel: { sources, entities: finalEntities, enums: enums.filter((e) => e.name && e.values.length).slice(0, 100) }, domainTypes };
}
