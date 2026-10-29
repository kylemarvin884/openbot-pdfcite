import { decodeStream, objectValue, readObjects, refList, refNumber } from "./objects.mjs";
import { extractPageText } from "./text.mjs";

export function extractPdf(buf) {
  const { objects, warnings } = readObjects(buf);
  const pages = [];

  const pageObjects = walkPageTree(objects);

  if (pageObjects.length) {
    for (const { object, resources } of pageObjects) {
      const contents = refList(object.dict, "Contents");
      const chunks = [];
      for (const num of contents) {
        const streamObject = objectValue(objects, num);
        const decoded = streamObject ? decodeStream(streamObject) : null;
        if (decoded) chunks.push(decoded.toString("latin1"));
      }
      const fonts = fontsFor(objects, resources ?? object);
      const xobjects = xobjectTree(objects, resources ?? object, 0);
      const { lines, warnings: textWarnings } = extractPageText(chunks.join("\n"), fonts, xobjects);
      for (const warning of textWarnings) warnings.push(warning);
      pages.push({ index: pages.length + 1, text: lines.join("\n") });
    }
  }

  if (!pages.length) {
    warnings.push("no page tree found; falling back to content streams ordered by object number");
    const candidates = [...objects.values()]
      .filter((object) => object.stream)
      .sort((a, b) => a.num - b.num);
    for (const object of candidates) {
      const decoded = decodeStream(object);
      if (!decoded) continue;
      const content = decoded.toString("latin1");
      if (!/\bBT\b/.test(content) || !/(Tj|TJ)\b/.test(content)) continue;
      const { lines } = extractPageText(content, new Map());
      const text = lines.join("\n");
      if (text.trim()) pages.push({ index: pages.length + 1, text });
    }
  }

  const textLayer = gradeTextLayer(pages);
  return {
    pages,
    info: {
      pageCount: pages.length,
      textLayer,
      warnings: [...new Set(warnings)],
    },
  };
}

function walkPageTree(objects) {
  const out = [];
  const seen = new Set();

  let root = null;
  for (const object of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(object.dict)) {
      root = refNumber(object.dict, "Pages");
      break;
    }
  }
  if (root === null) {
    for (const object of objects.values()) {
      if (/\/Type\s*\/Pages\b/.test(object.dict)) {
        root = object.num;
        break;
      }
    }
  }
  if (root === null) return out;

  const visit = (num, inheritedResources) => {
    if (num === null || seen.has(num)) return;
    seen.add(num);
    const object = objects.get(num);
    if (!object) return;

    const resources = resolveResources(objects, object.dict, inheritedResources);

    if (/\/Type\s*\/Page\b(?!s)/.test(object.dict)) {
      out.push({ object, resources });
      return;
    }
    for (const kid of refList(object.dict, "Kids")) visit(kid, resources);
  };

  visit(root, null);
  return out;
}

function resolveResources(objects, dict, inherited) {
  const ref = refNumber(dict, "Resources");
  if (ref !== null) return objects.get(ref) ?? inherited;
  const inline = inlineDict(dict, "Resources");
  if (inline) return { num: null, dict: inline, stream: null };
  return inherited;
}

// Extracts a balanced << ... >> body for /Key, so nested dictionaries survive.
export function inlineDict(text, key) {
  const start = new RegExp(`/${key}\\s*<<`).exec(text);
  if (!start) return null;
  let index = start.index + start[0].length;
  let depth = 1;
  const bodyStart = index;
  while (index < text.length && depth > 0) {
    if (text.startsWith("<<", index)) {
      depth += 1;
      index += 2;
    } else if (text.startsWith(">>", index)) {
      depth -= 1;
      if (depth === 0) return text.slice(bodyStart, index);
      index += 2;
    } else {
      index += 1;
    }
  }
  return null;
}

function fontsFor(objects, container) {
  const fonts = new Map();
  if (!container) return fonts;

  const dict = container.dict ?? "";
  const fontRef = refNumber(dict, "Font");
  const fontDictText = fontRef !== null ? objects.get(fontRef)?.dict ?? "" : inlineDict(dict, "Font") ?? "";

  for (const entry of fontDictText.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const object = objects.get(Number(entry[2]));
    if (!object) continue;
    fonts.set(entry[1], fontInfo(objects, object));
  }
  return fonts;
}

function xobjectTree(objects, resources, depth) {
  const map = new Map();
  if (!resources || depth > 4) return map;

  const dict = resources.dict ?? "";
  const ref = refNumber(dict, "XObject");
  const body = ref !== null ? objects.get(ref)?.dict ?? "" : inlineDict(dict, "XObject") ?? "";

  for (const entry of body.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
    const object = objects.get(Number(entry[2]));
    if (!object || !/\/Subtype\s*\/Form/.test(object.dict)) continue;
    const decoded = decodeStream(object);
    if (!decoded) continue;
    const own = resolveResources(objects, object.dict, resources);
    map.set(entry[1], {
      content: decoded.toString("latin1"),
      matrix: matrixOf(object.dict),
      fonts: fontsFor(objects, own),
      xobjects: xobjectTree(objects, own, depth + 1),
    });
  }
  return map;
}

function matrixOf(dict) {
  const match = /\/Matrix\s*\[([^\]]*)\]/.exec(dict);
  const fallback = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  if (!match) return fallback;
  const values = match[1].trim().split(/\s+/).map(Number);
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) return fallback;
  const [a, b, c, d, e, f] = values;
  return { a, b, c, d, e, f };
}

function fontInfo(objects, object) {
  const dict = object.dict;
  const twoByte =
    /\/Subtype\s*\/Type0\b/.test(dict) || /\/Encoding\s*\/Identity-[HV]\b/.test(dict);
  const toUnicode = refNumber(dict, "ToUnicode");
  let cmap = null;
  if (toUnicode !== null) {
    const stream = objects.get(toUnicode);
    const decoded = stream ? decodeStream(stream) : null;
    if (decoded) cmap = parseCMap(decoded.toString("latin1"));
  }
  return { twoByte, cmap };
}

export function parseCMap(text) {
  const map = new Map();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1], 16), hexToText(pair[2]));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    const entry = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    let match;
    while ((match = entry.exec(body)) !== null) {
      const lo = parseInt(match[1], 16);
      const hi = parseInt(match[2], 16);
      if (hi < lo || hi - lo > 65535) continue;
      if (match[3]) {
        const base = hexToCodePoints(match[3]);
        for (let code = lo; code <= hi; code += 1) {
          const offset = code - lo;
          const last = base[base.length - 1] + offset;
          map.set(code, String.fromCodePoint(...[...base.slice(0, -1), last]));
        }
      } else {
        const items = [...match[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => hexToText(m[1]));
        items.forEach((value, offset) => map.set(lo + offset, value));
      }
    }
  }

  return map;
}

function hexToText(hex) {
  return String.fromCodePoint(...hexToCodePoints(hex));
}

function hexToCodePoints(hex) {
  const points = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    points.push(parseInt(hex.slice(i, i + 4), 16));
  }
  if (!points.length && hex.length === 2) points.push(parseInt(hex, 16));
  return points;
}

function gradeTextLayer(pages) {
  if (!pages.length) return "none";
  const total = pages.reduce((sum, page) => sum + page.text.length, 0);
  if (total === 0) return "none";
  const perPage = total / pages.length;
  const suspicious = (pages.map((p) => p.text).join("").match(/[\u0000-\u0008\u000e-\u001f\ufffd]/g) ?? []).length;
  const ratio = suspicious / total;
  if (perPage < 40 || ratio > 0.02) return "low";
  return "good";
}
