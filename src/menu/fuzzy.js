// (From Pelican's menu.)
// Fuzzy matching for the list filters (/) and the command palette (:): the
// characters of a term appear in order, in any case. A whole substring beats
// scattered letters; matches at word starts and in runs score higher. Each
// space-separated term must match one of the fields.
const separators = /[\s\-_./\\:()[\]{}@#,]/;
const boundary = (text, i) =>
  i === 0 ||
  separators.test(text[i - 1]) ||
  (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

// { score, positions } of query in text, or null.
export function fuzzy(query, text) {
  const q = String(query ?? "").toLowerCase();
  const raw = String(text ?? "");
  const t = raw.toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const at = t.indexOf(q);
  if (at >= 0) {
    // The earliest word-start occurrence, if there is one.
    let best = at;
    for (let i = at; i >= 0 && i < t.length; i = t.indexOf(q, i + 1))
      if (boundary(raw, i)) {
        best = i;
        break;
      }
    return {
      score:
        200 +
        q.length * 10 -
        Math.min(best, 50) +
        (boundary(raw, best) ? 60 : 0),
      positions: Array.from({ length: q.length }, (_, k) => best + k),
    };
  }
  const positions = [];
  let score = 0,
    from = 0,
    last = -2;
  for (const ch of q) {
    let found = -1;
    // Prefer the next word start that has this letter, close by.
    for (let i = from; i < t.length && i < from + 24; i++)
      if (t[i] === ch && boundary(raw, i)) {
        found = i;
        break;
      }
    if (found < 0) found = t.indexOf(ch, from);
    if (found < 0) return null;
    score +=
      10 +
      (boundary(raw, found) ? 15 : 0) +
      (found === last + 1 ? 12 : 0) -
      Math.min(found - from, 10);
    positions.push(found);
    last = found;
    from = found + 1;
  }
  return { score, positions };
}

// The best total score of every term over the fields, or null when a term
// matches none of them.
export function matchFields(query, fields) {
  const terms = String(query ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return 0;
  let total = 0;
  for (const term of terms) {
    let best = null;
    for (const field of fields) {
      if (field === null || field === undefined || field === "") continue;
      const found = fuzzy(term, field);
      if (found && (best === null || found.score > best)) best = found.score;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
export const fuzzyMatches = (query, ...fields) =>
  matchFields(query, fields) !== null;
