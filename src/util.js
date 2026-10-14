import { randomUUID } from 'node:crypto';

export const round = (x, digits = 3) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(digits)));
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function stdev(values) {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
}

export function linreg(values) {
  const n = values.length;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  values.forEach((y, x) => {
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = den ? num / den : 0;
  return { slope, intercept: yMean - slope * xMean };
}

export const safeDiv = (a, b) => (a == null || b == null || b === 0 ? null : round(a / b, 4));
export const pct = (now, before) =>
  now == null || before == null || before === 0 ? null : round(((now - before) / before) * 100, 2);
export const newId = () => randomUUID();

const KEYWORD_STOPWORDS = new Set([
  'with', 'that', 'from', 'this', 'their', 'they', 'need', 'needs', 'more', 'than', 'have', 'will', 'into', 'about',
  'over', 'next', 'year', 'month', 'keep', 'below', 'grow', 'cut', 'each', 'when', 'what', 'which', 'your', 'teams',
  'team', 'small', 'mid', 'sized', 'were', 'been', 'also', 'very', 'just', 'there', 'these', 'those', 'some', 'only',
]);

// Most frequent words of 4+ letters, ignoring common filler words.
export function topKeywords(text, limit) {
  const counts = new Map();
  for (const word of String(text).toLowerCase().match(/[a-z]{4,}/g) ?? []) {
    if (KEYWORD_STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([word]) => word);
}
