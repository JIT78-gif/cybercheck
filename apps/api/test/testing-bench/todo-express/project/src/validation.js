"use strict";

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const PRIORITIES = ["low", "normal", "high"];
const CREATE_FIELDS = ["title", "notes", "priority", "dueDate"];
const PATCH_FIELDS = [...CREATE_FIELDS, "done"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function checkFields(body, allowed, errors) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) errors.push(`unknown field: ${key}`);
  }
}

function checkTitle(value, errors) {
  if (typeof value !== "string") {
    errors.push("title must be a string");
    return undefined;
  }
  const title = value.trim();
  if (title.length === 0) errors.push("title must not be empty");
  if (title.length > TITLE_MAX) errors.push(`title must be at most ${TITLE_MAX} characters`);
  return title;
}

function checkOptional(body, value, errors) {
  if ("notes" in body) {
    if (typeof body.notes !== "string") errors.push("notes must be a string");
    else if (body.notes.length > NOTES_MAX) errors.push(`notes must be at most ${NOTES_MAX} characters`);
    else value.notes = body.notes;
  }
  if ("priority" in body) {
    if (!PRIORITIES.includes(body.priority)) errors.push(`priority must be one of ${PRIORITIES.join(", ")}`);
    else value.priority = body.priority;
  }
  if ("dueDate" in body) {
    if (body.dueDate === null) value.dueDate = null;
    else if (!isValidDate(body.dueDate)) errors.push("dueDate must be a valid YYYY-MM-DD date");
    else value.dueDate = body.dueDate;
  }
}

function validateCreate(body) {
  const errors = [];
  if (!isPlainObject(body)) return { ok: false, errors: ["body must be a JSON object"] };
  checkFields(body, CREATE_FIELDS, errors);

  const value = {};
  if (!("title" in body)) errors.push("title is required");
  else value.title = checkTitle(body.title, errors);
  checkOptional(body, value, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function validatePatch(body) {
  const errors = [];
  if (!isPlainObject(body)) return { ok: false, errors: ["body must be a JSON object"] };
  checkFields(body, PATCH_FIELDS, errors);
  if (Object.keys(body).length === 0) errors.push("at least one field is required");

  const value = {};
  if ("title" in body) value.title = checkTitle(body.title, errors);
  if ("done" in body) {
    if (typeof body.done !== "boolean") errors.push("done must be a boolean");
    else value.done = body.done;
  }
  checkOptional(body, value, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value };
}

function parseId(raw) {
  if (typeof raw !== "string" || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  return Number(raw);
}

function parseListQuery(query) {
  const errors = [];
  const result = { done: undefined, limit: 50, offset: 0 };

  if (query.done !== undefined) {
    if (query.done === "true") result.done = true;
    else if (query.done === "false") result.done = false;
    else errors.push("done must be true or false");
  }
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) errors.push("limit must be an integer from 1 to 100");
    else result.limit = limit;
  }
  if (query.offset !== undefined) {
    const offset = Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0) errors.push("offset must be a non-negative integer");
    else result.offset = offset;
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: result };
}

module.exports = { validateCreate, validatePatch, parseId, parseListQuery, TITLE_MAX, NOTES_MAX };
