"use strict";

const STATUSES = ["open", "done"];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function checkTitle(value, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push("title must be a non-empty string");
    return undefined;
  }
  const title = value.trim();
  if (title.length > 200) errors.push("title must be at most 200 characters");
  return title;
}

function checkPriority(value, errors) {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    errors.push("priority must be an integer from 1 to 5");
    return undefined;
  }
  return value;
}

function validateCreate(body) {
  if (!isPlainObject(body)) return { errors: ["body must be a JSON object"] };
  const errors = [];
  const value = { title: checkTitle(body.title, errors) };
  if (body.priority !== undefined) value.priority = checkPriority(body.priority, errors);
  for (const key of Object.keys(body)) {
    if (!["title", "priority"].includes(key)) errors.push(`unknown field: ${key}`);
  }
  return errors.length ? { errors } : { value };
}

function validatePatch(body) {
  if (!isPlainObject(body)) return { errors: ["body must be a JSON object"] };
  const errors = [];
  const value = {};
  if (body.title !== undefined) value.title = checkTitle(body.title, errors);
  if (body.priority !== undefined) value.priority = checkPriority(body.priority, errors);
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) errors.push("status must be open or done");
    else value.status = body.status;
  }
  for (const key of Object.keys(body)) {
    if (!["title", "priority", "status"].includes(key)) errors.push(`unknown field: ${key}`);
  }
  if (Object.keys(value).length === 0 && errors.length === 0) errors.push("nothing to update");
  return errors.length ? { errors } : { value };
}

function parseId(raw) {
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

function parseListQuery(query) {
  const errors = [];
  const page = query.page === undefined ? 1 : Number(query.page);
  const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
  if (!Number.isInteger(page) || page < 1 || page > 100000) errors.push("page must be an integer >= 1");
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) errors.push("pageSize must be an integer from 1 to 100");
  if (query.status !== undefined && !STATUSES.includes(query.status)) errors.push("status must be open or done");
  return errors.length ? { errors } : { value: { page, pageSize, status: query.status } };
}

module.exports = { validateCreate, validatePatch, parseId, parseListQuery };
