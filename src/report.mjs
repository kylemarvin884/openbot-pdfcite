import path from "node:path";
import { VERSION } from "./pack.mjs";

const MARK = {
  exact: "✓",
  fuzzy: "≈",
  partial: "◐",
  moved: "→",
  split: "⚠",
  missing: "✗",
};

export function renderText(result) {
  const lines = [];
  const manifest = result.manifest;

  lines.push(`pdfcite ${VERSION}`);
  lines.push(`answer   ${short(result.answer)}`);
  if (manifest) {
    lines.push(
      `source   ${manifest.source.name}  sha256 ${manifest.source.sha256.slice(0, 12)}…  pages ${manifest.pages}  text_layer ${manifest.textLayer}`,
    );
  } else {
    lines.push(`sources  ${short(result.sources)}`);
  }

  const { counts } = result;
  lines.push(
    `quotes   ${result.quotes.length} → ${counts.exact} exact, ${counts.fuzzy} near, ${counts.partial} partial, ${counts.split} split, ${counts.moved} moved, ${counts.missing} missing`,
  );
  if (result.warning) lines.push(`warning  ${result.warning}`);
  for (const note of result.notes ?? []) lines.push(`note     ${note}`);
  lines.push("");

  for (const verdict of result.quotes) {
    const snippet = clip(verdict.text.replace(/\s+/g, " "), 52);
    const where = `p${verdict.page}`.padEnd(5);
    lines.push(`  ${MARK[verdict.status]} ${where} ${snippet.padEnd(54)} ${verdict.detail}`);
  }

  if (result.quotes.length) lines.push("");
  if (!result.quotes.length) {
    lines.push("nothing to check → exit 0");
  } else if (result.failed) {
    lines.push(`${result.failed} unverified → exit 1`);
  } else if (result.warnings) {
    lines.push(`0 unverified, ${result.warnings} warning(s) → exit 0`);
  } else {
    lines.push("all quotes verified → exit 0");
  }

  return `${lines.join("\n")}\n`;
}

export function renderJson(result) {
  const payload = {
    tool: "pdfcite",
    version: VERSION,
    answer: result.answer,
    source: result.manifest
      ? {
          name: result.manifest.source.name,
          sha256: result.manifest.source.sha256,
          pages: result.manifest.pages,
          textLayer: result.manifest.textLayer,
        }
      : null,
    counts: result.counts,
    unverified: result.failed ?? 0,
    quotes: result.quotes.map((verdict) => ({
      index: verdict.index,
      line: verdict.line,
      citedPage: verdict.page,
      foundPage: verdict.foundPage,
      status: verdict.status,
      score: Number(verdict.score.toFixed(4)),
      quote: verdict.text,
    })),
    notes: result.notes ?? [],
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderPackText(pack) {
  const manifest = pack.manifest;
  const lines = [
    `pdfcite ${VERSION}`,
    `packed   ${manifest.source.name}  sha256 ${manifest.source.sha256.slice(0, 12)}…`,
    `pages    ${manifest.pages}  chars ${manifest.chars}  text_layer ${manifest.textLayer}`,
    `output   ${path.join(pack.outDir, "pages.jsonl")}`,
    `         ${path.join(pack.outDir, "context.md")}`,
    `         ${path.join(pack.outDir, "manifest.json")}`,
  ];
  for (const warning of manifest.warnings) lines.push(`warning  ${warning}`);
  if (manifest.textLayer !== "good") {
    lines.push("note     text_layer is not good: verify a few sentences by hand before trusting the check");
  }
  return `${lines.join("\n")}\n`;
}

function clip(text, max) {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

function short(file) {
  return path.isAbsolute(file) ? path.relative(process.cwd(), file) || file : file;
}
