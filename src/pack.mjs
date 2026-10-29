import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractPdf } from "./pdf/extract.mjs";

export const VERSION = "0.1.0";

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function packPdf(pdfPath, outDir) {
  const buffer = fs.readFileSync(pdfPath);
  const { pages, info } = extractPdf(buffer);

  if (!pages.length || info.textLayer === "none") {
    throw new Error(
      `${pdfPath}: no text layer found. Scanned PDFs are not supported — run OCR first, then pack the OCR'd PDF.`,
    );
  }

  fs.mkdirSync(outDir, { recursive: true });

  const lines = pages.map((page) =>
    JSON.stringify({
      page: page.index,
      chars: page.text.length,
      sha256: crypto.createHash("sha256").update(page.text).digest("hex").slice(0, 16),
      text: page.text,
    }),
  );
  fs.writeFileSync(path.join(outDir, "pages.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const context = [
    `# ${path.basename(pdfPath)} — page-anchored context`,
    "",
    "Quote checks read `pages.jsonl`. Cite pages as `[pN]` in the answer, never as a guess.",
    "",
    ...pages.flatMap((page) => [`## p${page.index}`, "", page.text, ""]),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "context.md"), context, "utf8");

  const manifest = {
    tool: "pdfcite",
    version: VERSION,
    source: {
      name: path.basename(pdfPath),
      sha256: sha256(buffer),
      bytes: buffer.length,
    },
    pages: pages.length,
    chars: pages.reduce((sum, page) => sum + page.text.length, 0),
    textLayer: info.textLayer,
    warnings: info.warnings,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { outDir, manifest };
}
