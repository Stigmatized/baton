// A small line diff (longest common subsequence) for showing what `baton
// install` changes. Files here are small (settings.json, one command file).

export function diffLines(before, after, { context = 2 } = {}) {
  const a = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const b = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  if (a.at(-1) === "") a.pop();
  if (b.at(-1) === "") b.pop();
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j]))
      ops.push({ kind: "+", text: b[j++] });
    else ops.push({ kind: "-", text: a[i++] });
  }
  const changed = ops
    .map((op, k) => (op.kind !== " " ? k : -1))
    .filter((k) => k >= 0);
  if (!changed.length) return [];
  const keep = new Set();
  for (const k of changed)
    for (
      let c = Math.max(0, k - context);
      c <= Math.min(ops.length - 1, k + context);
      c++
    )
      keep.add(c);
  const out = [];
  let last = -1;
  for (let k = 0; k < ops.length; k++) {
    if (!keep.has(k)) continue;
    if (last >= 0 && k > last + 1) out.push("  ...");
    out.push(`${ops[k].kind} ${ops[k].text}`);
    last = k;
  }
  return out;
}
