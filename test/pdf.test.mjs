import test from "node:test";
import assert from "node:assert/strict";
import { extractPdf, parseCMap } from "../src/pdf/extract.mjs";
import { decodeString, extractPageText, tokenize } from "../src/pdf/text.mjs";
import { makePdf } from "../demo/make-pdf.mjs";

test("extracts one line per text line, uncompressed", () => {
  const pdf = makePdf({ pages: [["Purchase order 4711", "Delivery within 30 days."]] });
  const { pages, info } = extractPdf(pdf);
  assert.equal(pages.length, 1);
  assert.equal(info.textLayer, "good");
  assert.match(pages[0].text, /Purchase order 4711/);
  assert.match(pages[0].text, /Delivery within 30 days\./);
  assert.equal(pages[0].text.split("\n").length, 2);
});

test("keeps page order and page numbers across pages", () => {
  const pdf = makePdf({ pages: [["first page"], ["second page"], ["third page"]] });
  const { pages } = extractPdf(pdf);
  assert.deepEqual(pages.map((page) => page.index), [1, 2, 3]);
  assert.match(pages[1].text, /second page/);
});

test("inflates FlateDecode content streams", () => {
  const pdf = makePdf({ pages: [["compressed body text"]], compress: true });
  const { pages } = extractPdf(pdf);
  assert.match(pages[0].text, /compressed body text/);
});

test("decodes windows-1252 punctuation without a ToUnicode map", () => {
  const pdf = makePdf({ pages: [["Term \u0097 notice period"]] });
  const { pages } = extractPdf(pdf);
  assert.match(pages[0].text, /Term — notice period/);
});

test("decodes a Type0 font through its ToUnicode CMap", () => {
  const sentence = "供应商应在三十天内交付设备。";
  const pdf = makePdf({ pages: [[sentence]], cjk: true });
  const { pages } = extractPdf(pdf);
  assert.equal(pages[0].text, sentence);
});

test("reports no text layer for a PDF without text operators", () => {
  const pdf = makePdf({ pages: [[]] });
  const { pages, info } = extractPdf(pdf);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].text, "");
  assert.equal(info.textLayer, "none");
});

test("parseCMap handles bfchar and bfrange", () => {
  const cmap = [
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "2 beginbfchar",
    "<0001> <4E2D>",
    "<0002> <6587>",
    "endbfchar",
    "1 beginbfrange",
    "<0010> <0012> <0041>",
    "endbfrange",
    "endcmap",
  ].join("\n");
  const map = parseCMap(cmap);
  assert.equal(map.get(0x0001), "中");
  assert.equal(map.get(0x0002), "文");
  assert.equal(map.get(0x0011), "B");
});

test("tokenizer keeps nested parentheses and escapes inside strings", () => {
  const tokens = [...tokenize("(a \\(b\\) c) Tj")];
  assert.equal(tokens[0].type, "str");
  assert.equal(tokens[0].value.toString("latin1"), "a (b) c");
});

test("TJ arrays turn large negative kerning into a space", () => {
  const { lines } = extractPageText("BT /F1 10 Tf 1 0 0 1 10 700 Tm [(Hello) -300 (world)] TJ ET");
  assert.equal(lines[0], "Hello world");
});

test("decodeString falls back to latin1 when the font has no map", () => {
  assert.equal(decodeString(Buffer.from("plain", "latin1"), null), "plain");
});
