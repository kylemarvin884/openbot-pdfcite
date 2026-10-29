import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePdf } from "../demo/make-pdf.mjs";

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

function fixture({ pages, answer, compress = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfcite-"));
  const pdf = path.join(dir, "doc.pdf");
  fs.writeFileSync(pdf, makePdf({ pages, compress }));
  const answerPath = path.join(dir, "answer.md");
  fs.writeFileSync(answerPath, answer, "utf8");
  return { dir, pdf, answerPath, ctx: path.join(dir, "ctx") };
}

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
}

const pages = [
  ["1.1 Payment is due within forty-five (45) days of a valid invoice."],
  ["2.1 Either party may terminate with sixty (60) days written notice."],
];

test("a correct answer exits 0", () => {
  const { pdf, answerPath, ctx } = fixture({
    pages,
    answer: [
      "> Payment is due within forty-five (45) days of a valid invoice. [p1]",
      "> Either party may terminate with sixty (60) days written notice. [p2]",
    ].join("\n"),
  });
  assert.equal(run(["pack", pdf, "--out", ctx]).status, 0);
  const result = run(["check", answerPath, "--sources", ctx]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /all quotes verified/);
});

test("a wrong page and an invented quote exit 1", () => {
  const { pdf, answerPath, ctx } = fixture({
    pages,
    answer: [
      "> Payment is due within forty-five (45) days of a valid invoice. [p2]",
      "> All units carry a ninety day warranty. [p1]",
    ].join("\n"),
  });
  run(["pack", pdf, "--out", ctx]);
  const result = run(["check", answerPath, "--sources", ctx]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not on the cited page/);
  assert.match(result.stdout, /not found/);
  assert.match(result.stdout, /2 unverified/);
});

test("--allow-moved downgrades a moved quote to a warning", () => {
  const { pdf, answerPath, ctx } = fixture({
    pages,
    answer: "> Payment is due within forty-five (45) days of a valid invoice. [p2]",
  });
  run(["pack", pdf, "--out", ctx]);
  assert.equal(run(["check", answerPath, "--sources", ctx]).status, 1);
  const relaxed = run(["check", answerPath, "--sources", ctx, "--allow-moved"]);
  assert.equal(relaxed.status, 0);
  assert.match(relaxed.stdout, /warning/);
});

test("--json returns machine readable verdicts", () => {
  const { pdf, answerPath, ctx } = fixture({
    pages,
    answer: "> Payment is due within forty-five (45) days of a valid invoice. [p1]",
  });
  run(["pack", pdf, "--out", ctx]);
  const result = run(["check", answerPath, "--sources", ctx, "--json"]);
  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.quotes.length, 1);
  assert.equal(payload.quotes[0].status, "exact");
  assert.equal(payload.quotes[0].citedPage, 1);
  assert.equal(payload.unverified, 0);
});

test("pack writes pages.jsonl, context.md and manifest.json", () => {
  const { pdf, ctx } = fixture({ pages, answer: "" });
  const result = run(["pack", pdf, "--out", ctx]);
  assert.equal(result.status, 0);
  for (const file of ["pages.jsonl", "context.md", "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(ctx, file)), `${file} should exist`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(ctx, "manifest.json"), "utf8"));
  assert.equal(manifest.pages, 2);
  assert.equal(manifest.textLayer, "good");
  assert.match(fs.readFileSync(path.join(ctx, "context.md"), "utf8"), /## p2/);
});

test("check without packed sources exits 2 with a hint", () => {
  const { dir, answerPath } = fixture({ pages, answer: "> x [p1]" });
  const result = run(["check", answerPath, "--sources", path.join(dir, "missing")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /pdfcite pack/);
});

test("pack refuses a PDF with no text layer", () => {
  const { dir } = fixture({ pages: [[]], answer: "" });
  const pdf = path.join(dir, "blank.pdf");
  fs.writeFileSync(pdf, makePdf({ pages: [[]] }));
  const result = run(["pack", pdf, "--out", path.join(dir, "ctx")]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no text layer/);
});

test("an answer without anchored quotes exits 0 and says so", () => {
  const { pdf, answerPath, ctx } = fixture({ pages, answer: "Just prose, no citations.\n" });
  run(["pack", pdf, "--out", ctx]);
  const result = run(["check", answerPath, "--sources", ctx]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no blockquote with a page anchor was found/);
  assert.match(result.stdout, /nothing to check/);
});

test("unknown flags exit 2", () => {
  const result = run(["check", "x.md", "--nope"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag/);
});
