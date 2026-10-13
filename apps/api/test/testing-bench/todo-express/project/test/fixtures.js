"use strict";

const WORDS = [
  "buy", "milk", "call", "dentist", "book", "flight", "review", "pull", "request",
  "renew", "passport", "water", "plants", "pay", "invoice", "plan", "sprint",
  "update", "docs", "clean", "garage", "email", "team", "fix", "printer",
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Builds a realistic looking todo title of varying length. */
function randomTitle() {
  const target = 10 + Math.floor(Math.random() * 380);
  const words = [];
  let length = 0;
  while (length < target) {
    const word = pick(WORDS);
    length += word.length + (words.length > 0 ? 1 : 0);
    words.push(word);
  }
  return words.join(" ");
}

module.exports = { randomTitle };
