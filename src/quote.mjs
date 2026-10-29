// Reads the answer Markdown and pulls out quotable claims.
//
// One quote = one blockquote paragraph. The anchor can sit anywhere in the
// block: [p7], [p 7], (p. 7), (p7), (pp. 7-8), （第 7 页）.

const ANCHOR_PATTERNS = [
  /\[\s*p\.?\s*(\d+)\s*\]/i,
  /\(\s*pp?\.?\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*\)/i,
  /（\s*第\s*(\d+)\s*页\s*）/,
  /\[\s*pages?\s+(\d+)(?:\s*[-–]\s*(\d+))?\s*\]/i,
];

export function parseAnswer(markdown) {
  const lines = markdown.split(/\r?\n/);
  const quotes = [];
  let block = null;
  let inFence = false;

  const flush = () => {
    if (!block) return;
    const raw = block.parts.join(" ").replace(/\s+/g, " ").trim();
    const anchor = findAnchor(raw);
    if (anchor && stripAnchor(raw).trim().length > 0) {
      quotes.push({
        index: quotes.length + 1,
        line: block.line,
        page: anchor.page,
        pageEnd: anchor.pageEnd,
        text: stripAnchor(raw).trim(),
      });
    }
    block = null;
  };

  for (const [offset, line] of lines.entries()) {
    if (/^\s{0,3}```/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quoted) {
      // Two adjacent blockquote lines with their own anchors are two quotes, not
      // one quote with two page numbers.
      if (block && block.hasAnchor && findAnchor(quoted[1])) flush();
      if (!block) block = { line: offset + 1, parts: [], hasAnchor: false };
      if (quoted[1].trim()) {
        block.parts.push(quoted[1].trim());
        if (findAnchor(quoted[1])) block.hasAnchor = true;
      }
      continue;
    }
    if (!line.trim() || /^\s{0,3}(#{1,6}\s|---)/.test(line)) {
      flush();
      continue;
    }
    flush();
  }
  flush();

  return quotes;
}

export function findAnchor(text) {
  for (const pattern of ANCHOR_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        page: Number(match[1]),
        pageEnd: match[2] ? Number(match[2]) : Number(match[1]),
      };
    }
  }
  return null;
}

export function stripAnchor(text) {
  let out = text;
  for (const pattern of ANCHOR_PATTERNS) {
    out = out.replace(pattern, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}
