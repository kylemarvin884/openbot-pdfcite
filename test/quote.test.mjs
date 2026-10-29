import test from "node:test";
import assert from "node:assert/strict";
import { findAnchor, parseAnswer, stripAnchor } from "../src/quote.mjs";

test("reads one blockquote per quote and strips the anchor", () => {
  const md = ["# Answer", "", "> Delivery is due in 30 days. [p2]", "", "Some prose.", ""].join("\n");
  const quotes = parseAnswer(md);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].page, 2);
  assert.equal(quotes[0].text, "Delivery is due in 30 days.");
});

test("supports the English and Chinese page-anchor forms", () => {
  assert.equal(findAnchor("text (p. 7)").page, 7);
  assert.equal(findAnchor("text (p7)").page, 7);
  assert.equal(findAnchor("text （第 7 页）").page, 7);
  assert.equal(findAnchor("text [pages 4]").page, 4);
  assert.deepEqual(findAnchor("text (pp. 7-8)"), { page: 7, pageEnd: 8 });
  assert.equal(findAnchor("no anchor here"), null);
});

test("joins a multi-line blockquote and takes the anchor from the last line", () => {
  const md = ["> First part of the quote", "> and the second part. （第 3 页）"].join("\n");
  const quotes = parseAnswer(md);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].page, 3);
  assert.equal(quotes[0].text, "First part of the quote and the second part.");
});

test("ignores blockquotes without an anchor", () => {
  const md = "> quoted but never cited\n";
  assert.deepEqual(parseAnswer(md), []);
});

test("ignores blockquotes inside fenced code", () => {
  const md = ["```", "> not a real quote [p1]", "```"].join("\n");
  assert.deepEqual(parseAnswer(md), []);
});

test("keeps quotes separated by prose apart", () => {
  const md = ["> one [p1]", "", "prose", "", "> two [p2]"].join("\n");
  const quotes = parseAnswer(md);
  assert.deepEqual(quotes.map((quote) => quote.page), [1, 2]);
});

test("stripAnchor removes every supported form", () => {
  assert.equal(stripAnchor("quote [p9]"), "quote");
  assert.equal(stripAnchor("quote (pp. 9-10)"), "quote");
  assert.equal(stripAnchor("quote （第 9 页）"), "quote");
});
