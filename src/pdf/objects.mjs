import zlib from "node:zlib";

// PDF parsing that only needs what text extraction needs:
// objects, their dictionaries, and decoded streams. No xref table: objects are
// found by scanning for "N G obj" and object streams (PDF 1.5+) are expanded so
// cross-reference damage in the middle of a file does not matter.

const OBJ_RE = /(\d+)\s+(\d+)\s+obj\b/g;

export function readObjects(buf) {
  const text = buf.toString("latin1");
  const objects = new Map();
  const warnings = [];

  OBJ_RE.lastIndex = 0;
  let match;
  while ((match = OBJ_RE.exec(text)) !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endobj = text.indexOf("endobj", bodyStart);
    if (endobj === -1) continue;
    const body = text.slice(bodyStart, endobj);
    const stream = cutStream(buf, text, bodyStart, body);
    objects.set(num, { num, dict: stream.dict, stream: stream.data });
  }

  const expanded = expandObjectStreams(objects, warnings);
  return { objects: expanded, warnings };
}

function cutStream(buf, text, bodyStart, body) {
  const at = body.search(/stream(\r\n|\r|\n)/);
  if (at === -1) return { dict: body, data: null };

  const eol = body.slice(at + 6).match(/^(\r\n|\r|\n)/)[1].length;
  const dataStart = bodyStart + at + 6 + eol;
  const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(body);

  let dataEnd = -1;
  if (length) {
    const declared = Number(length[1]);
    if (declared > 0 && dataStart + declared <= buf.length) dataEnd = dataStart + declared;
  }
  if (dataEnd === -1) {
    dataEnd = text.indexOf("endstream", dataStart);
    if (dataEnd === -1) dataEnd = buf.length;
  }

  const dict = body.slice(0, at);
  let data = buf.subarray(dataStart, dataEnd);
  while (data.length && (data[data.length - 1] === 0x0a || data[data.length - 1] === 0x0d)) {
    data = data.subarray(0, data.length - 1);
  }
  return { dict, data };
}

function expandObjectStreams(objects, warnings) {
  const out = new Map(objects);
  for (const obj of [...objects.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(obj.dict)) continue;
    const decoded = decodeStream(obj);
    if (!decoded) {
      warnings.push(`object stream #${obj.num} could not be decoded`);
      continue;
    }
    const header = decoded.toString("latin1");
    const n = Number((/\/N\s+(\d+)/.exec(obj.dict) ?? [])[1]);
    const first = Number((/\/First\s+(\d+)/.exec(obj.dict) ?? [])[1]);
    if (!Number.isFinite(n) || !Number.isFinite(first)) continue;

    const numbers = header.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i += 1) {
      const objNum = numbers[i * 2];
      const offset = numbers[i * 2 + 1];
      const nextOffset = i + 1 < n ? numbers[(i + 1) * 2 + 1] : header.length - first;
      if (!Number.isFinite(objNum) || !Number.isFinite(offset)) continue;
      if (out.has(objNum)) continue;
      const piece = header.slice(first + offset, first + nextOffset);
      out.set(objNum, { num: objNum, dict: piece, stream: null, inObjectStream: true });
    }
  }
  return out;
}

export function decodeStream(obj) {
  if (!obj.stream) return null;
  const filters = [...obj.dict.matchAll(/\/(FlateDecode|ASCIIHexDecode|ASCII85Decode|LZWDecode)\b/g)].map(
    (m) => m[1],
  );
  let data = obj.stream;
  for (const filter of filters) {
    if (filter === "FlateDecode") {
      const inflated = inflate(data);
      if (!inflated) return null;
      data = inflated;
    } else if (filter === "ASCIIHexDecode") {
      data = asciiHex(data);
    } else if (filter === "ASCII85Decode") {
      data = ascii85(data);
    } else {
      return null;
    }
  }
  return data;
}

function inflate(data) {
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.gunzipSync]) {
    try {
      return fn(data);
    } catch {
      // try the next framing
    }
  }
  return null;
}

function asciiHex(data) {
  const clean = data
    .toString("latin1")
    .replace(/\s+/g, "")
    .replace(/>.*$/, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  return Buffer.from(padded, "hex");
}

export function ascii85(data) {
  let text = data.toString("latin1").replace(/\s+/g, "");
  if (text.startsWith("<~")) text = text.slice(2);
  const end = text.indexOf("~>");
  if (end >= 0) text = text.slice(0, end);

  const out = [];
  let group = [];
  const expand = () => {
    const n = ((((group[0] * 85 + group[1]) * 85 + group[2]) * 85 + group[3]) * 85 + group[4]);
    return [
      Math.floor(n / 16777216) % 256,
      Math.floor(n / 65536) % 256,
      Math.floor(n / 256) % 256,
      n % 256,
    ];
  };

  for (const ch of text) {
    if (ch === "z" && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    group.push(code);
    if (group.length === 5) {
      out.push(...expand());
      group = [];
    }
  }
  if (group.length > 1) {
    const count = group.length;
    while (group.length < 5) group.push(84);
    out.push(...expand().slice(0, count - 1));
  }
  return Buffer.from(out);
}

export function refNumber(text, key) {
  const single = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text);
  if (single) return Number(single[1]);
  return null;
}

export function refList(text, key) {
  const array = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(text);
  if (!array) {
    const single = refNumber(text, key);
    return single === null ? [] : [single];
  }
  return [...array[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
}

export function objectValue(objects, num) {
  return num === null ? null : objects.get(num) ?? null;
}
