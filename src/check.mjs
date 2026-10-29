import fs from "node:fs";
import path from "node:path";
import { checkQuote, preparePages, summarize } from "./match.mjs";
import { parseAnswer } from "./quote.mjs";

export function loadSources(sourcesDir) {
  const pagesFile = path.join(sourcesDir, "pages.jsonl");
  if (!fs.existsSync(pagesFile)) {
    throw new Error(`${pagesFile} not found. Run "pdfcite pack <file.pdf> --out ${sourcesDir}" first.`);
  }
  const pages = fs
    .readFileSync(pagesFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  const manifestFile = path.join(sourcesDir, "manifest.json");
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : null;

  if (manifest?.textLayer === "low") {
    return { pages, manifest, warning: "text_layer is low: some quotes may fail because extraction is noisy, not because the answer is wrong" };
  }
  return { pages, manifest, warning: null };
}

export function runCheck(answerPath, sourcesDir, options = {}) {
  const { pages, manifest, warning } = loadSources(sourcesDir);
  const markdown = fs.readFileSync(answerPath, "utf8");
  const quotes = parseAnswer(markdown);

  if (!quotes.length) {
    return {
      answer: answerPath,
      sources: sourcesDir,
      manifest,
      quotes: [],
      counts: { exact: 0, fuzzy: 0, moved: 0, split: 0, missing: 0 },
      failed: 0,
      warning,
      notes: ["no blockquote with a page anchor was found"],
    };
  }

  const prepared = preparePages(pages);
  const verdicts = quotes.map((quote) => ({
    index: quote.index,
    line: quote.line,
    text: quote.text,
    ...checkQuote(prepared, quote, { minFuzzy: options.minFuzzy }),
  }));

  const counts = summarize(verdicts);
  const failed = counts.missing + counts.partial + (options.allowMoved ? 0 : counts.moved);
  const warnings = counts.fuzzy + counts.split + (options.allowMoved ? counts.moved : 0);

  return {
    answer: answerPath,
    sources: sourcesDir,
    manifest,
    quotes: verdicts,
    counts,
    ok: counts.exact,
    failed,
    warnings,
    warning,
  };
}
