#!/usr/bin/env node
// Builds a synthetic 4-page agreement, writes an answer with six quotes
// (three correct, one paraphrase, one on the wrong page, one that spans a page
// break, one fabricated), then runs pack + check. No network, no model.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makePdf } from "./make-pdf.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "out");
const cli = path.join(here, "..", "src", "cli.mjs");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const pages = [
  [
    "SUPPLIER AGREEMENT - SECTION 1",
    "1.1 The supplier shall deliver the hardware within thirty (30) days of the purchase order.",
    "1.2 Late delivery incurs a penalty of 0.5% of the order value per day.",
  ],
  [
    "SECTION 2 - PAYMENT",
    "2.1 Payment is due within forty-five (45) days of a valid invoice.",
    "2.2 The customer may withhold payment for defective units.",
  ],
  [
    "SECTION 3 - TERM AND CONFIDENTIALITY",
    "3.1 Either party may terminate for convenience with sixty (60) days written notice.",
    "3.2 Confidentiality obligations survive termination for a period of five (5) years.",
  ],
  [
    "SECTION 4 - GOVERNING LAW",
    "4.1 This agreement is governed by the laws of Singapore.",
    "4.2 Disputes shall be resolved by arbitration in Singapore.",
  ],
];

const pdfPath = path.join(out, "agreement.pdf");
fs.writeFileSync(pdfPath, makePdf({ pages, compress: true }));

const answer = `# Agreement summary

## Delivery

> The supplier shall deliver the hardware within thirty (30) days of the purchase order. [p1]

## Payment

> Payment is due within forty-five (45) days of a valid invoice. [p2]

> The customer can withhold payment for defective units. (p. 2)

## Termination

> Either party may terminate for convenience with sixty (60) days written notice. [p3]

> Confidentiality obligations survive termination for a period of five (5) years. This agreement is governed by the laws of Singapore. [p3]

## Penalties

> Late delivery incurs a penalty of 0.5% of the order value per day. [p4]

## Warranty

> The supplier shall provide a ninety (90) day warranty on all delivered units. [p3]
`;

const answerPath = path.join(out, "answer.md");
fs.writeFileSync(answerPath, answer, "utf8");

const run = (args) => {
  try {
    return execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
};

const ctx = path.join(out, "ctx");
process.stdout.write(run(["pack", pdfPath, "--out", ctx]));
process.stdout.write("\n");
process.stdout.write(run(["check", answerPath, "--sources", ctx]));
process.stdout.write("\n");
process.stdout.write(`fixtures: ${path.relative(process.cwd(), out)}\n`);
