// Content-stream interpreter: turns one page's content stream (and the form
// XObjects it invokes) into lines of text. Only the operators that move text or
// show glyphs are implemented; the rest are skipped, which is what a text
// extractor needs.

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_FORM_DEPTH = 6;

export function* tokenize(src) {
  let i = 0;
  while (i < src.length) {
    const code = src.charCodeAt(i);

    if (WHITESPACE.has(code)) {
      i += 1;
      continue;
    }

    if (code === 0x25) {
      while (i < src.length && src.charCodeAt(i) !== 0x0a && src.charCodeAt(i) !== 0x0d) i += 1;
      continue;
    }

    if (code === 0x28) {
      const [value, next] = readLiteral(src, i);
      yield { type: "str", value };
      i = next;
      continue;
    }

    if (code === 0x3c) {
      if (src.charCodeAt(i + 1) === 0x3c) {
        yield { type: "op", value: "<<" };
        i += 2;
        continue;
      }
      const end = src.indexOf(">", i + 1);
      const body = src.slice(i + 1, end === -1 ? src.length : end).replace(/\s+/g, "");
      const padded = body.length % 2 ? `${body}0` : body;
      yield { type: "str", value: Buffer.from(padded, "hex") };
      i = end === -1 ? src.length : end + 1;
      continue;
    }

    if (code === 0x3e && src.charCodeAt(i + 1) === 0x3e) {
      yield { type: "op", value: ">>" };
      i += 2;
      continue;
    }

    if (code === 0x5b || code === 0x5d) {
      yield { type: "op", value: String.fromCharCode(code) };
      i += 1;
      continue;
    }

    if (code === 0x2f) {
      let j = i + 1;
      while (j < src.length && !WHITESPACE.has(src.charCodeAt(j)) && !DELIMITERS.has(src.charCodeAt(j))) {
        j += 1;
      }
      const raw = src.slice(i + 1, j);
      yield {
        type: "name",
        value: raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
      };
      i = j;
      continue;
    }

    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(src.slice(i, i + 24));
    if (number) {
      yield { type: "num", value: Number(number[0]) };
      i += number[0].length;
      continue;
    }

    let j = i;
    while (j < src.length && !WHITESPACE.has(src.charCodeAt(j)) && !DELIMITERS.has(src.charCodeAt(j))) j += 1;
    if (j === i) j += 1;
    yield { type: "op", value: src.slice(i, j) };
    i = j;
  }
}

function readLiteral(src, start) {
  const bytes = [];
  let depth = 1;
  let i = start + 1;
  while (i < src.length) {
    const code = src.charCodeAt(i);
    if (code === 0x5c) {
      const next = src.charCodeAt(i + 1);
      i += 2;
      if (next === 0x6e) bytes.push(0x0a);
      else if (next === 0x72) bytes.push(0x0d);
      else if (next === 0x74) bytes.push(0x09);
      else if (next === 0x62) bytes.push(0x08);
      else if (next === 0x66) bytes.push(0x0c);
      else if (next === 0x0d) {
        if (src.charCodeAt(i) === 0x0a) i += 1;
      } else if (next === 0x0a) {
        // escaped newline: line continuation, emits nothing
      } else if (next >= 0x30 && next <= 0x37) {
        let digits = String.fromCharCode(next);
        while (digits.length < 3 && src.charCodeAt(i) >= 0x30 && src.charCodeAt(i) <= 0x37) {
          digits += src[i];
          i += 1;
        }
        bytes.push(parseInt(digits, 8) & 0xff);
      } else {
        bytes.push(next & 0xff);
      }
      continue;
    }
    if (code === 0x28) depth += 1;
    if (code === 0x29) {
      depth -= 1;
      if (depth === 0) return [Buffer.from(bytes), i + 1];
    }
    bytes.push(code & 0xff);
    i += 1;
  }
  return [Buffer.from(bytes), i];
}

const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

function translate(matrix, tx, ty) {
  return {
    ...matrix,
    e: matrix.e + tx * matrix.a + ty * matrix.c,
    f: matrix.f + tx * matrix.b + ty * matrix.d,
  };
}

let win1252 = null;

function latinText(bytes) {
  if (/[\x80-\x9f]/.test(bytes.toString("latin1"))) {
    try {
      win1252 ??= new TextDecoder("windows-1252");
      return win1252.decode(bytes);
    } catch {
      // ICU-less builds: fall through to latin1
    }
  }
  return bytes.toString("latin1");
}

export function decodeString(bytes, font) {
  if (!font) return latinText(bytes);
  if (font.twoByte) {
    let out = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      out += font.cmap?.get(code) ?? "";
    }
    return out;
  }
  if (font.cmap && font.cmap.size) {
    let out = "";
    for (const byte of bytes) out += font.cmap.get(byte) ?? String.fromCharCode(byte);
    return out;
  }
  // Without a /ToUnicode map, WinAnsi and PDFDocEncoding agree with latin1 for
  // the printable range, which is all a quote check needs.
  return latinText(bytes);
}

export function extractPageText(content, fonts, xobjects = new Map()) {
  const { runs, warnings } = extractRuns(content, { fonts, xobjects, depth: 0 });
  return { lines: layout(runs), warnings };
}

export function extractRuns(content, { fonts = new Map(), xobjects = new Map(), depth = 0 } = {}) {
  const runs = [];
  const warnings = new Set();

  let tm = identity();
  let tlm = identity();
  let leading = 0;
  let size = 12;
  let fontName = null;

  let stack = [];
  const show = (bytes, extraSpace = false) => {
    const font = fonts.get(fontName) ?? null;
    let text = decodeString(bytes, font);
    if (extraSpace) text = ` ${text}`;
    if (!text) return;
    runs.push({ x: tm.e, y: tm.f, size, text });
  };

  for (const token of tokenize(content)) {
    if (token.type !== "op") {
      stack.push(token);
      continue;
    }
    const op = token.value;
    switch (op) {
      case "[":
        stack.push({ type: "marker", value: "[" });
        break;
      case "]": {
        const items = [];
        while (stack.length) {
          const item = stack.pop();
          if (item.type === "marker") break;
          items.unshift(item);
        }
        stack.push({ type: "array", value: items });
        break;
      }
      case "BT":
        tm = identity();
        tlm = identity();
        stack = [];
        break;
      case "Tf": {
        const nameToken = stack.at(-2);
        const sizeToken = stack.at(-1);
        if (nameToken?.type === "name") fontName = nameToken.value;
        if (sizeToken?.type === "num") size = sizeToken.value || 12;
        stack = [];
        break;
      }
      case "Td":
      case "TD": {
        const tx = numberAt(stack, -2);
        const ty = numberAt(stack, -1);
        if (op === "TD") leading = -ty;
        tlm = translate(tlm, tx, ty);
        tm = { ...tlm };
        stack = [];
        break;
      }
      case "Tm": {
        const [a, b, c, d, e, f] = [-6, -5, -4, -3, -2, -1].map((n) => numberAt(stack, n));
        tlm = { a, b, c, d, e, f };
        tm = { ...tlm };
        stack = [];
        break;
      }
      case "T*":
        tlm = translate(tlm, 0, -leading);
        tm = { ...tlm };
        stack = [];
        break;
      case "TL":
        leading = numberAt(stack, -1);
        stack = [];
        break;
      case "Tj": {
        const arg = lastOfType(stack, "str");
        if (arg) show(arg.value);
        stack = [];
        break;
      }
      case "TJ": {
        const array = lastOfType(stack, "array");
        if (array) {
          let extraSpace = false;
          for (const item of array.value) {
            if (item.type === "str") {
              show(item.value, extraSpace);
              extraSpace = false;
            } else if (item.type === "num" && item.value < -120) {
              extraSpace = true;
            }
          }
        }
        stack = [];
        break;
      }
      case "'":
      case "\"": {
        const arg = lastOfType(stack, "str");
        tlm = translate(tlm, 0, -leading);
        tm = { ...tlm };
        if (arg) show(arg.value);
        stack = [];
        break;
      }
      case "Do": {
        const nameToken = stack.at(-1);
        const target = nameToken?.type === "name" ? xobjects.get(nameToken.value) : null;
        if (!target) {
          warnings.add("a form XObject could not be resolved (text inside it may be missing)");
        } else if (depth < MAX_FORM_DEPTH) {
          const sub = extractRuns(target.content, {
            fonts: target.fonts ?? new Map(),
            xobjects: target.xobjects ?? new Map(),
            depth: depth + 1,
          });
          for (const run of sub.runs) runs.push(transformRun(run, target.matrix ?? identity()));
          for (const warning of sub.warnings) warnings.add(warning);
        }
        stack = [];
        break;
      }
      default:
        stack = [];
        break;
    }
  }

  return { runs, warnings: [...warnings] };
}

function transformRun(run, matrix) {
  return {
    x: matrix.a * run.x + matrix.c * run.y + matrix.e,
    y: matrix.b * run.x + matrix.d * run.y + matrix.f,
    size: run.size * Math.max(0.2, Math.abs(matrix.d || 1)),
    text: run.text,
  };
}

function numberAt(stack, offset) {
  const item = stack.at(offset);
  return item?.type === "num" ? item.value : 0;
}

function lastOfType(stack, type) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]?.type === type) return stack[i];
  }
  return null;
}

function charWidth(ch, size) {
  const code = ch.codePointAt(0);
  const wide = code > 0x2e80 && code < 0xa4d0;
  return (wide ? 1 : 0.5) * size;
}

function layout(runs) {
  if (!runs.length) return [];
  const sorted = [...runs].sort((a, b) => (Math.abs(a.y - b.y) < 0.6 ? a.x - b.x : b.y - a.y));

  const lines = [];
  let current = null;
  for (const run of sorted) {
    const tolerance = Math.max(1.2, run.size * 0.35);
    if (!current || Math.abs(current.y - run.y) > tolerance) {
      current = { y: run.y, size: run.size, runs: [run] };
      lines.push(current);
    } else {
      current.runs.push(run);
    }
  }

  return lines
    .map((line) => {
      const ordered = [...line.runs].sort((a, b) => a.x - b.x);
      let text = "";
      let endX = null;
      for (const run of ordered) {
        if (endX !== null) {
          const gap = run.x - endX;
          const needsSpace = gap > run.size * 0.18 && !/\s$/.test(text) && !/^\s/.test(run.text);
          if (needsSpace) text += " ";
        }
        text += run.text;
        const width = [...run.text].reduce((sum, ch) => sum + charWidth(ch, run.size), 0);
        endX = run.x + width;
      }
      return text.replace(/[ \t]+/g, " ").trim();
    })
    .filter((line) => line.length > 0);
}
