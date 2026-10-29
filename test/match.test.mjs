import test from "node:test";
import assert from "node:assert/strict";
import { bestWindow, checkQuote, dice, normalize, preparePages, summarize } from "../src/match.mjs";

const pages = preparePages([
  {
    page: 1,
    text: "Late delivery incurs a penalty of 0.5% of the order value per day. The supplier shall deliver within thirty (30) days.",
  },
  { page: 2, text: "Payment is due within forty-five (45) days of a valid invoice. Confidentiality survives for five years." },
  { page: 3, text: "This agreement is governed by the laws of Singapore. Disputes go to arbitration." },
]);

test("exact match on the cited page", () => {
  const verdict = checkQuote(pages, { text: "Payment is due within forty-five (45) days", page: 2 });
  assert.equal(verdict.status, "exact");
  assert.equal(verdict.foundPage, 2);
});

test("match ignores case and whitespace differences", () => {
  const verdict = checkQuote(pages, { text: "PAYMENT   is due within forty-five (45) days", page: 2 });
  assert.equal(verdict.status, "exact");
});

test("match survives a space inserted inside a word by extraction", () => {
  const broken = preparePages([{ page: 1, text: "Authorize the G itH ub account before the sync starts." }]);
  const verdict = checkQuote(broken, { text: "Authorize the GitHub account before the sync starts.", page: 1 });
  assert.equal(verdict.status, "exact");
  assert.match(verdict.detail, /word spacing/);
});

test("quote on another page is reported as moved", () => {
  const verdict = checkQuote(pages, { text: "Late delivery incurs a penalty of 0.5% of the order value per day.", page: 2 });
  assert.equal(verdict.status, "moved");
  assert.equal(verdict.foundPage, 1);
});

test("a paraphrase on the right page is a fuzzy match, not exact", () => {
  const verdict = checkQuote(pages, { text: "Payment must be made within forty-five (45) days of a valid invoice.", page: 2 });
  assert.equal(verdict.status, "fuzzy");
  assert.ok(verdict.score >= 0.8 && verdict.score < 1);
});

test("a quote that extends the source sentence is partial", () => {
  const verdict = checkQuote(pages, {
    text: "Payment is due within forty-five (45) days of a valid invoice and must be paid in cash.",
    page: 2,
  });
  assert.equal(verdict.status, "partial");
  assert.match(verdict.detail, /only the first/);
});

test("invented text is missing", () => {
  const verdict = checkQuote(pages, { text: "The supplier warrants all units for ninety days.", page: 2 });
  assert.equal(verdict.status, "missing");
});

test("an anchor outside the document is missing, with a clear detail", () => {
  const verdict = checkQuote(pages, { text: "anything", page: 9 });
  assert.equal(verdict.status, "missing");
  assert.match(verdict.detail, /does not exist/);
});

test("a quote that starts on one page and ends on the next is split", () => {
  const splitPages = preparePages([
    { page: 1, text: "Section 1. Section 2. Confidentiality obligations survive termination for a period of five (5) years." },
    { page: 2, text: "This agreement is governed by the laws of Singapore. Section 4." },
  ]);
  const verdict = checkQuote(splitPages, {
    text: "Confidentiality obligations survive termination for a period of five (5) years. This agreement is governed by the laws of Singapore.",
    page: 1,
  });
  assert.equal(verdict.status, "split");
  assert.equal(verdict.foundPage, 2);
});

test("a page range accepts both pages", () => {
  const verdict = checkQuote(pages, { text: "Disputes go to arbitration.", page: 2, pageEnd: 3 });
  assert.equal(verdict.status, "exact");
  assert.equal(verdict.foundPage, 3);
});

test("normalize joins hyphenated line breaks and unifies punctuation", () => {
  assert.equal(normalize("organ-\nize"), "organize");
  assert.equal(normalize("“quoted” — text"), '"quoted" - text');
});

test("dice scores identical strings as 1 and unrelated ones near 0", () => {
  assert.equal(dice("abcde", "abcde"), 1);
  assert.ok(dice("abcde", "zyxwv") < 0.2);
});

test("bestWindow finds the offset of a known quote", () => {
  const text = "header header header the exact sentence appears here";
  const { score, at } = bestWindow(text, "the exact sentence appears here");
  assert.equal(score, 1);
  assert.equal(text.slice(at, at + 32), "the exact sentence appears here");
});

test("summarize counts every status", () => {
  const counts = summarize([
    { status: "exact" },
    { status: "fuzzy" },
    { status: "partial" },
    { status: "moved" },
    { status: "split" },
    { status: "missing" },
  ]);
  assert.deepEqual(counts, { exact: 1, fuzzy: 1, partial: 1, moved: 1, split: 1, missing: 1 });
});
