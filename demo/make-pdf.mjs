// Minimal PDF writer used by the demo and the tests. It produces a real PDF
// (xref table, page tree, optional Flate compression and an Identity-H font with
// a /ToUnicode map) so extraction is exercised on bytes, not on mocks.

import zlib from "node:zlib";

export function makePdf({ pages, compress = false, cjk = false, form = false }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // object numbers start at 1
  };

  const catalogNum = add(null); // placeholder, patched below
  const pagesNum = add(null);
  const fontNum = add(null);
  const cjkMap = cjk ? buildCjkFont() : null;

  const fontBody = cjk
    ? "<< /Type /Font /Subtype /Type0 /BaseFont /Faux-Identity /Encoding /Identity-H /DescendantFonts [] /ToUnicode "
    : null;

  const contentNums = [];
  const pageNums = [];

  for (const [index, lines] of pages.entries()) {
    const content = cjk ? renderCjkContent(lines, cjkMap) : renderLatinContent(lines);
    const bytes = compress ? zlib.deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
    const filter = compress ? " /Filter /FlateDecode" : "";

    if (form) {
      const formNum = add({
        dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 612 792] /Matrix [1 0 0 1 0 0] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Length ${bytes.length}${filter} >>`,
        data: bytes,
      });
      const wrapper = Buffer.from("q /Fm0 Do Q\n", "latin1");
      const wrapperNum = add({ dict: `<< /Length ${wrapper.length} >>`, data: wrapper });
      contentNums.push(wrapperNum);
      pageNums.push(
        add(
          `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Contents ${wrapperNum} 0 R ` +
            `/Resources << /XObject << /Fm0 ${formNum} 0 R >> >> >>`,
        ),
      );
      continue;
    }

    const dict = `<< /Length ${bytes.length}${filter} >>`;
    contentNums.push(add({ dict, data: bytes }));
    pageNums.push(
      add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] /Contents ${contentNums[index]} 0 R >>`),
    );
  }

  objects[catalogNum - 1] = `<< /Type /Catalog /Pages ${pagesNum} 0 R >>`;
  objects[pagesNum - 1] =
    `<< /Type /Pages /Count ${pageNums.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] ` +
    `/Resources << /Font << /F1 ${fontNum} 0 R >> >> >>`;

  if (cjk) {
    const toUnicodeNum = add({
      dict: null,
      data: Buffer.from(cjkMap.cmap, "latin1"),
    });
    objects[toUnicodeNum - 1] = {
      dict: `<< /Length ${Buffer.from(cjkMap.cmap, "latin1").length} /Filter /FlateDecode >>`,
      data: zlib.deflateSync(Buffer.from(cjkMap.cmap, "latin1")),
      overrideDict: true,
    };
    objects[fontNum - 1] = `${fontBody}${toUnicodeNum} 0 R >>`;
  } else {
    objects[fontNum - 1] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  }

  return serialize(objects, catalogNum);
}

function renderLatinContent(lines) {
  const body = lines.map((line) => `(${escapeLiteral(line)}) Tj T*`).join("\n");
  return `BT\n/F1 11 Tf\n15 TL\n1 0 0 1 72 720 Tm\n${body}\nET\n`;
}

function renderCjkContent(lines, cjkMap) {
  const body = lines
    .map((line) => {
      const hex = [...line].map((ch) => cjkMap.codeFor(ch).toString(16).padStart(4, "0")).join("");
      return `<${hex}> Tj T*`;
    })
    .join("\n");
  return `BT\n/F1 11 Tf\n15 TL\n1 0 0 1 72 720 Tm\n${body}\nET\n`;
}

function buildCjkFont() {
  const codes = new Map();
  const chars = [];
  const codeFor = (ch) => {
    if (codes.has(ch)) return codes.get(ch);
    const code = codes.size + 1;
    codes.set(ch, code);
    chars.push(ch);
    return code;
  };
  const cmapHeader = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ].join("\n");
  const cmapFooter = ["endcmap", "end", "end"].join("\n");

  return {
    codeFor,
    get cmap() {
      const entries = chars.map((ch) => {
        const code = codes.get(ch).toString(16).padStart(4, "0");
        const utf16 = [...Buffer.from(ch, "utf16le").swap16()].map((b) => b.toString(16).padStart(2, "0")).join("");
        return `<${code}> <${utf16}>`;
      });
      return `${cmapHeader}\n${entries.length} beginbfchar\n${entries.join("\n")}\nendbfchar\n${cmapFooter}`;
    },
  };
}

function escapeLiteral(text) {
  return text.replace(/([\\()])/g, "\\$1");
}

function serialize(objects, rootNum) {
  const chunks = [];
  let length = 0;
  const push = (chunk) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "latin1");
    chunks.push(buffer);
    length += buffer.length;
  };

  push("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n");

  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    const num = index + 1;
    if (object && typeof object === "object" && object.data) {
      const dict = object.overrideDict ? object.dict : object.dict;
      push(`${num} 0 obj\n${dict}\nstream\n`);
      push(object.data);
      push("\nendstream\nendobj\n");
      return;
    }
    push(`${num} 0 obj\n${object}\nendobj\n`);
  });

  const xrefStart = length;
  const rows = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f "];
  for (const offset of offsets) rows.push(`${String(offset).padStart(10, "0")} 00000 n `);
  push(`${rows.join("\n")}\n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return Buffer.concat(chunks);
}
