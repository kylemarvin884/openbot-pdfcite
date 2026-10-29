const QUOTE_MAP = new Map([
  ["\u2018", "'"],
  ["\u2019", "'"],
  ["\u201c", '"'],
  ["\u201d", '"'],
  ["\u00ab", '"'],
  ["\u00bb", '"'],
  ["\u2013", "-"],
  ["\u2014", "-"],
  ["\u2212", "-"],
  ["\u00a0", " "],
]);

export function normalize(text) {
  let out = text.normalize("NFKC");
  out = out.replace(/\u00ad/g, "");
  out = out.replace(/(\p{Ll})-\s*\n\s*(\p{Ll})/gu, "$1$2");
  out = out.replace(/[\u2018\u2019\u201c\u201d\u00ab\u00bb\u2013\u2014\u2212\u00a0]/g, (ch) => QUOTE_MAP.get(ch) ?? ch);
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function preparePages(pages) {
  return pages.map((page) => {
    const norm = normalize(page.text ?? "");
    return { page: page.page, raw: page.text ?? "", norm, lower: norm.toLowerCase() };
  });
}

export function dice(a, b) {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = grams.get(gram) ?? 0;
    if (count > 0) {
      grams.set(gram, count - 1);
      hits += 1;
    }
  }
  const total = a.length - 1 + (b.length - 1);
  return (2 * hits) / total;
}

export function bestWindow(text, quote) {
  if (quote.length < 8) return { score: 0, at: -1 };
  const base = quote.length;
  const widths = [0.8, 0.9, 1, 1.1, 1.2].map((factor) => Math.max(6, Math.round(base * factor)));
  let best = { score: 0, at: -1, width: base };

  for (const width of widths) {
    const step = Math.max(1, Math.floor(width / 8));
    for (let i = 0; i + width <= text.length; i += step) {
      const score = dice(quote, text.slice(i, i + width));
      if (score > best.score) best = { score, at: i, width };
    }
  }

  if (best.at >= 0) {
    const step = Math.max(1, Math.floor(best.width / 8));
    for (let i = Math.max(0, best.at - step); i <= Math.min(text.length - best.width, best.at + step); i += 1) {
      const score = dice(quote, text.slice(i, i + best.width));
      if (score > best.score) best = { score, at: i, width: best.width };
    }
  }
  return best;
}

// Cheap gate for the document-wide fuzzy search: if a page shares none of the
// quote's longer words, it cannot plausibly contain the quote.
export function anchorTokens(quote) {
  const tokens = [...new Set(quote.match(/[\p{L}\p{N}]{5,}/gu) ?? [])];
  return tokens.sort((a, b) => b.length - a.length).slice(0, 3);
}

export function stripSpaces(text) {
  return text.replace(/\s+/g, "");
}

export function checkQuote(pages, quote, { minFuzzy = 0.8 } = {}) {
  const q = normalize(quote.text);
  const qLower = q.toLowerCase();
  // Claiming a quote sits on a page is a stronger claim than "the wording
  // differs", so the bar for finding it elsewhere is higher.
  const movedThreshold = Math.max(minFuzzy, 0.88);
  const anchor = pages.find((page) => page.page === quote.page);

  if (!anchor) {
    return {
      status: "missing",
      page: quote.page,
      foundPage: null,
      score: 0,
      detail: `anchor p${quote.page} does not exist (document has ${pages.length} pages)`,
    };
  }

  const targetPages = pages.filter((page) => page.page >= quote.page && page.page <= (quote.pageEnd ?? quote.page));
  for (const page of targetPages) {
    if (page.norm.includes(q) || page.lower.includes(qLower)) {
      return { status: "exact", page: page.page, foundPage: page.page, score: 1, detail: "exact match" };
    }
  }

  // Extraction sometimes inserts a space inside a word (or drops one between
  // words). A space-insensitive pass catches those without loosening the quote.
  const qTight = stripSpaces(q);
  if (qTight.length >= 12) {
    for (const page of targetPages) {
      if (stripSpaces(page.norm).includes(qTight)) {
        return {
          status: "exact",
          page: page.page,
          foundPage: page.page,
          score: 1,
          detail: "exact match (ignoring word spacing)",
        };
      }
    }
  }

  // A quote that starts verbatim and then trails off into words that are not in
  // the document is the common "model extended the sentence" failure.
  for (const page of targetPages) {
    const partial = longestPrefixMatch(page.norm, q);
    if (partial) {
      return {
        status: "partial",
        page: page.page,
        foundPage: page.page,
        score: partial.ratio,
        detail: `only the first ${Math.round(partial.ratio * 100)}% is on p${page.page}; the rest is not in the document`,
      };
    }
  }

  for (const page of targetPages) {
    const { score } = bestWindow(page.norm, q);
    if (score >= minFuzzy) {
      return {
        status: "fuzzy",
        page: page.page,
        foundPage: page.page,
        score,
        detail: `near match on the cited page (${(score * 100).toFixed(1)}%)`,
      };
    }
  }

  const split = findSplit(pages, quote.page, q);
  if (split) {
    return {
      status: "split",
      page: quote.page,
      foundPage: split.nextPage,
      score: split.score,
      detail: `quote crosses the page break (p${quote.page}→p${split.nextPage})`,
    };
  }

  for (const page of pages) {
    if (page.page === quote.page) continue;
    const loose = qTight.length >= 12 && stripSpaces(page.norm).includes(qTight);
    if (page.norm.includes(q) || page.lower.includes(qLower) || loose) {
      return {
        status: "moved",
        page: quote.page,
        foundPage: page.page,
        score: 1,
        detail: `found on p${page.page}, not on the cited page`,
      };
    }
  }

  const tokens = anchorTokens(q);
  for (const page of pages) {
    if (page.page === quote.page) continue;
    if (tokens.length && !tokens.some((token) => page.norm.includes(token))) continue;
    const { score } = bestWindow(page.norm, q);
    if (score >= movedThreshold) {
      return {
        status: "moved",
        page: quote.page,
        foundPage: page.page,
        score,
        detail: `near match on p${page.page} (${(score * 100).toFixed(1)}%), not on the cited page`,
      };
    }
  }

  return {
    status: "missing",
    page: quote.page,
    foundPage: null,
    score: 0,
    detail: "not found in the document",
  };
}

function findSplit(pages, anchorPage, quote) {
  const current = pages.find((page) => page.page === anchorPage);
  const next = pages.find((page) => page.page === anchorPage + 1);
  if (!current || !next) return null;

  for (const ratio of [0.5, 0.6, 0.7, 0.8]) {
    const cut = nearestSpace(quote, Math.floor(quote.length * ratio));
    if (cut < 30 || quote.length - cut < 20) continue;
    const head = quote.slice(0, cut).trim();
    const tail = quote.slice(cut).trim();
    const headTail = head.slice(-80);
    const tailHead = tail.slice(0, 80);
    const headHit = current.norm.lastIndexOf(headTail) >= Math.max(0, current.norm.length - 400);
    const tailHit = next.norm.indexOf(tailHead) >= 0 && next.norm.indexOf(tailHead) <= 400;
    if (headHit && tailHit) {
      return { nextPage: next.page, score: 1 };
    }
  }
  return null;
}

function nearestSpace(text, index) {
  for (let offset = 0; offset < 40; offset += 1) {
    for (const candidate of [index - offset, index + offset]) {
      if (candidate > 0 && candidate < text.length && text[candidate] === " ") return candidate;
    }
  }
  return index;
}

function longestPrefixMatch(pageNorm, quote) {
  const words = quote.split(" ");
  if (words.length < 8) return null;
  for (const ratio of [0.9, 0.8, 0.7, 0.6]) {
    const count = Math.max(1, Math.floor(words.length * ratio));
    const prefix = words.slice(0, count).join(" ");
    if (prefix.length < 24) continue;
    if (pageNorm.includes(prefix)) {
      const tail = words.slice(count).join(" ");
      if (tail.length < 3) continue;
      return { ratio: prefix.length / quote.length };
    }
  }
  return null;
}

export function summarize(verdicts) {
  const counts = { exact: 0, fuzzy: 0, partial: 0, moved: 0, split: 0, missing: 0 };
  for (const verdict of verdicts) counts[verdict.status] += 1;
  return counts;
}
