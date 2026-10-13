"use strict";

const { validateCreate, validatePatch, parseId, TITLE_MAX } = require("../src/validation");

describe("validateCreate", () => {
  test("accepts a title at the maximum length", () => {
    const result = validateCreate({ title: "x".repeat(TITLE_MAX) });
    expect(result.ok).toBe(true);
  });

  test("rejects a title one character over the maximum", () => {
    const result = validateCreate({ title: "x".repeat(TITLE_MAX + 1) });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object bodies", () => {
    expect(validateCreate(null).ok).toBe(false);
    expect(validateCreate([{ title: "a" }]).ok).toBe(false);
  });
});

describe("validatePatch", () => {
  test("requires at least one field", () => {
    expect(validatePatch({}).ok).toBe(false);
  });

  test("allows clearing the due date", () => {
    expect(validatePatch({ dueDate: null })).toEqual({ ok: true, value: { dueDate: null } });
  });
});

describe("parseId", () => {
  test("accepts positive integers only", () => {
    expect(parseId("12")).toBe(12);
    expect(parseId("0")).toBeNull();
    expect(parseId("-1")).toBeNull();
    expect(parseId("1.5")).toBeNull();
    expect(parseId("abc")).toBeNull();
  });
});
