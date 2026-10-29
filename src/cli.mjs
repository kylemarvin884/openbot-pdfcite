#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { runCheck } from "./check.mjs";
import { VERSION, packPdf } from "./pack.mjs";
import { renderJson, renderPackText, renderText } from "./report.mjs";

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    fail(error.message, 2);
    return;
  }

  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  try {
    if (options.command === "pack") {
      if (!options.input) throw new UsageError("pack needs a PDF path");
      const outDir = options.out ?? "ctx";
      const pack = packPdf(options.input, outDir);
      process.stdout.write(options.json ? `${JSON.stringify(pack.manifest, null, 2)}\n` : renderPackText(pack));
      if (pack.manifest.textLayer === "none") process.exitCode = 2;
      return;
    }

    if (options.command === "check") {
      if (!options.input) throw new UsageError("check needs an answer Markdown path");
      if (!fs.existsSync(options.input)) throw new UsageError(`${options.input} does not exist`);
      const result = runCheck(options.input, options.sources ?? "ctx", {
        allowMoved: options.allowMoved,
        minFuzzy: options.minFuzzy,
      });
      process.stdout.write(options.json ? renderJson(result) : renderText(result));
      process.exitCode = result.failed ? 1 : 0;
      return;
    }

    throw new UsageError(`unknown command: ${options.command}`);
  } catch (error) {
    fail(error.message, error instanceof UsageError ? 2 : 2);
  }
}

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    command: argv[0] && !argv[0].startsWith("-") ? argv[0] : "help",
    input: null,
    out: null,
    sources: null,
    json: false,
    allowMoved: false,
    minFuzzy: 0.88,
    help: false,
    version: false,
  };

  const rest = options.command === "help" ? argv : argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-v") options.version = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--allow-moved") options.allowMoved = true;
    else if (arg === "--out") options.out = requireValue(rest, ++i, "--out");
    else if (arg === "--sources") options.sources = requireValue(rest, ++i, "--sources");
    else if (arg === "--min-fuzzy") {
      const value = Number(requireValue(rest, ++i, "--min-fuzzy"));
      if (!Number.isFinite(value) || value <= 0 || value > 1) throw new UsageError("--min-fuzzy must be between 0 and 1");
      options.minFuzzy = value;
    } else if (arg.startsWith("-")) throw new UsageError(`unknown flag: ${arg}`);
    else if (!options.input) options.input = arg;
    else throw new UsageError(`unexpected argument: ${arg}`);
  }

  if (!options.input && !options.help && !options.version && options.command !== "help") {
    throw new UsageError(`${options.command} needs an input path`);
  }
  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new UsageError(`${flag} needs a value`);
  return value;
}

function fail(message, code) {
  process.stderr.write(`pdfcite: ${message}\n`);
  process.exitCode = code;
}

function helpText() {
  return `pdfcite ${VERSION} — check that every quote sits on the page it claims

Usage
  pdfcite pack <file.pdf> [--out ctx] [--json]
  pdfcite check <answer.md> [--sources ctx] [--json] [--allow-moved] [--min-fuzzy 0.88]

pack    extract page text and write pages.jsonl, context.md, manifest.json
check   verify every blockquote with a page anchor: [p7], (p. 7), （第 7 页）

Exit codes
  0  no quote is missing or on the wrong page (near/split quotes are warnings)
  1  at least one quote is missing or on the wrong page
  2  usage error, unreadable file, or no text layer

Limits
  No OCR: scanned PDFs are refused instead of guessed.
  No model calls: matching is exact, then fuzzy, then a document-wide search.
`;
}

main();

