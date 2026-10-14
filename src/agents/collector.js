// Agent 0 — Collector: live-fetches source URLs (feeds, JSON reviews, review pages) and analyses pasted documents.
// Fetched text is untrusted: the parser redacts and injection-flags it exactly like form input.
import { detectInjection, redactPII } from '../guardrails.js';
import { fetchSource } from '../scrapers.js';
import { aspectSentiments, labelOf, scoreText } from '../sentiment.js';
import { round, topKeywords } from '../util.js';

const FACT_PATTERN = /(\d+(?:\.\d+)?\s?%|[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:million|billion|k|x)\b)/i;

function analyzeDocument(doc) {
  const redacted = redactPII(doc.text);
  const text = redacted.text;
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  const terms = topKeywords(text, 10);
  const termSet = new Set(terms);

  // Extractive summary: the three sentences richest in the document's top terms, kept in original order.
  const ranked = sentences
    .map((s, index) => {
      const words = s.toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const hits = words.filter((w) => termSet.has(w)).length;
      return { index, s, score: words.length ? hits / Math.sqrt(words.length) : 0 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index);

  const sentiment = scoreText(text);
  return {
    title: doc.title,
    words: (text.match(/[A-Za-z']+/g) ?? []).length,
    sentences: sentences.length,
    sentiment: { score: sentiment.score, label: labelOf(sentiment.score) },
    summary: ranked.map((r) => r.s),
    facts: sentences.filter((s) => FACT_PATTERN.test(s)).slice(0, 8),
    topTerms: terms,
    aspects: aspectSentiments(text),
    redactions: redacted.counts,
    flagged: detectInjection(doc.text),
    score: round(sentiment.score, 3),
  };
}

export async function collectorAgent(ctx) {
  const { input } = ctx;
  const sources = await Promise.all(input.sourceUrls.map((url) => fetchSource(url)));
  const reviews = sources.flatMap((s) => s.items.map((item) => ({ ...item, source: s.url })));
  const documents = input.documents.map(analyzeDocument);
  const okCount = sources.filter((s) => s.status === 'ok').length;

  return {
    summary: `Fetched ${okCount}/${sources.length} source(s) into ${reviews.length} item(s); analysed ${documents.length} document(s).`,
    sources: sources.map(({ items, ...rest }) => rest),
    reviews,
    documents,
  };
}
