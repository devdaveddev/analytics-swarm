// Agent 1 — Parser & Researcher: normalises input, redacts PII, flags injection text,
// attaches industry benchmarks and assesses data quality.
import { BENCHMARKS } from '../benchmarks.js';
import { detectInjection, redactPII } from '../guardrails.js';
import { clamp } from '../util.js';

export async function parserAgent(ctx) {
  const { input } = ctx;
  const redactions = {};
  const clean = (text) => {
    const r = redactPII(text);
    for (const [type, n] of Object.entries(r.counts)) redactions[type] = (redactions[type] ?? 0) + n;
    return r.text;
  };

  // Fetched web text joins the pasted reviews and gets the same redaction and injection checks.
  const incoming = [...input.reviews, ...(ctx.collector?.reviews ?? [])];
  const reviews = incoming.map((r) => ({
    rating: r.rating,
    text: clean(r.text),
    injection: detectInjection(r.text),
    source: r.source ?? 'form',
  }));
  const injectionFlags = reviews.filter((r) => r.injection).length;

  const company = {
    name: input.companyName,
    industry: input.industry,
    region: input.region,
    employees: input.employees,
    annualRevenue: input.annualRevenue,
    currency: input.currency,
    goals: clean(input.goals),
    targetCustomers: clean(input.targetCustomers),
    products: input.products.map(clean),
    competitors: input.competitors,
  };

  const issues = [];
  if (input.metrics.length < 3) issues.push(`Only ${input.metrics.length} month(s) of metrics; trends need at least 3.`);
  if (!reviews.length) issues.push('No customer reviews provided; sentiment analysis is skipped.');
  const missing = ['customers', 'marketing_spend', 'leads', 'conversions', 'churned'].filter((f) =>
    input.metrics.some((row) => row[f] === null),
  );
  if (missing.length) issues.push(`Missing fields in some rows: ${missing.join(', ')}.`);
  if (!input.competitors.length) issues.push('No competitors listed; competitor gap analysis is limited.');
  if (injectionFlags) issues.push(`${injectionFlags} review(s) contained instruction-like text and were excluded from AI prompts.`);

  const score = clamp(100 - issues.length * 10 - (input.metrics.length < 3 ? 15 : 0), 0, 100);
  const totalRedactions = Object.values(redactions).reduce((a, b) => a + b, 0);
  const known = input.industry in BENCHMARKS;

  return {
    summary: `Parsed ${input.metrics.length} month(s) and ${reviews.length} review(s) for ${input.companyName}; redacted ${totalRedactions} PII item(s); data quality ${score}/100.`,
    company,
    metrics: input.metrics,
    reviews,
    benchmarks: {
      industry: known ? input.industry : 'general',
      ...BENCHMARKS[known ? input.industry : 'general'],
      source: 'built-in illustrative defaults',
    },
    dataQuality: { score, issues },
    redactions,
    injectionFlags,
  };
}
