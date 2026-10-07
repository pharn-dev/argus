// Small statistics and table helpers for the harness reports.

export function median(values) {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Coefficient of variation (sample standard deviation / mean); 0 for fewer than two values. */
export function cv(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance) / Math.abs(mean);
}

/** Median and spread of one metric across rounds. */
export function spread(values) {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    cv: cv(values),
    n: values.length,
  };
}

/** Relative change of `value` against `base`, or undefined when there is no base. */
export function delta(value, base) {
  if (base === undefined || !Number.isFinite(base) || base === 0) return undefined;
  return (value - base) / base;
}

export function fmtNumber(value, digits = 0) {
  if (value === undefined || !Number.isFinite(value)) return '-';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(fraction, { signed = true } = {}) {
  if (fraction === undefined || !Number.isFinite(fraction)) return '';
  const pct = fraction * 100;
  const sign = signed && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

/** A value with its delta in parentheses, e.g. `26,165 (-13.6%)`. */
export function withDelta(text, fraction) {
  const d = fmtPct(fraction);
  return d === '' ? text : `${text} (${d})`;
}

/** Render rows as a GitHub-flavoured Markdown table (readable as plain text too). */
export function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => `| ${cells.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [
    line(headers),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}
