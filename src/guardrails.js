// Guardrails: input validation, PII redaction, prompt-injection flagging and output checks.
import { round } from './util.js';
import { DEFAULT_ORDER, validateWorkflow } from './workflow.js';

export const INDUSTRIES = ['saas', 'ecommerce', 'retail', 'services', 'manufacturing', 'healthcare', 'fintech', 'general'];

export const LIMITS = {
  companyName: 120,
  industry: 40,
  region: 80,
  goals: 1000,
  targetCustomers: 500,
  employees: 10_000_000,
  annualRevenue: 1e12,
  products: { max: 20, length: 80 },
  competitors: { max: 10, length: 80 },
  reviews: { max: 2000, length: 2000 },
  metricsRows: 120,
};

const PII_RULES = [
  { type: 'card', pattern: /\b(?:\d[ -]?){13,16}\b/g, token: '[CARD]' },
  { type: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, token: '[EMAIL]' },
  { type: 'phone', pattern: /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, token: '[PHONE]' },
];

const INJECTION =
  /\b(ignore (all |any |the )?(previous|prior|above) (instructions|prompts?|rules)|disregard (the )?(above|previous|prior)|you are now|system prompt|reveal (your|the) (prompt|instructions))/i;

const ALIASES = {
  spend: 'marketing_spend',
  ad_spend: 'marketing_spend',
  churn: 'churned',
  churned_customers: 'churned',
  new_leads: 'leads',
};
const METRIC_FIELDS = ['customers', 'marketing_spend', 'leads', 'conversions', 'churned'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function sanitizeText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function redactPII(text) {
  const counts = {};
  let out = String(text);
  for (const rule of PII_RULES) {
    out = out.replace(rule.pattern, () => {
      counts[rule.type] = (counts[rule.type] || 0) + 1;
      return rule.token;
    });
  }
  return { text: out, counts };
}

export const detectInjection = (text) => INJECTION.test(String(text));

const normaliseKey = (key) =>
  String(key)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
const canonicalKey = (key) => ALIASES[key] ?? key;

function numberOrError(value, label, errors, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push(`${label} is required.`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s_]/g, ''));
  if (!Number.isFinite(n) || n < 0) {
    errors.push(`${label} must be a non-negative number.`);
    return null;
  }
  return n;
}

export function parseMetrics(source, errors) {
  if (source === undefined || source === null || source === '') return [];
  let rows;
  if (Array.isArray(source)) {
    rows = source.map((row) =>
      isPlainObject(row) ? Object.fromEntries(Object.entries(row).map(([k, v]) => [canonicalKey(normaliseKey(k)), v])) : {},
    );
  } else if (typeof source === 'string') {
    const lines = source.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return [];
    const header = lines[0].split(',').map((h) => canonicalKey(normaliseKey(h)));
    rows = lines.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    });
  } else {
    errors.push('Metrics must be CSV text or an array of rows.');
    return [];
  }
  if (rows.length > LIMITS.metricsRows) {
    errors.push(`At most ${LIMITS.metricsRows} metric rows are allowed.`);
    return [];
  }
  return rows.map((row, i) => {
    const label = `Metrics row ${i + 1}`;
    const month = sanitizeText(row.month, 20);
    if (!month) errors.push(`${label}: "month" is required.`);
    const out = { month, revenue: numberOrError(row.revenue, `${label} revenue`, errors, { required: true }) };
    for (const field of METRIC_FIELDS) out[field] = numberOrError(row[field], `${label} ${field}`, errors);
    return out;
  });
}

export function parseReviews(source, errors, warnings) {
  if (source === undefined || source === null || source === '') return [];
  let items;
  if (Array.isArray(source)) {
    items = source.map((x) => (typeof x === 'string' ? { rating: null, text: x } : { rating: x?.rating ?? null, text: x?.text }));
  } else if (typeof source === 'string') {
    items = source
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^([1-5])\s*\|\s*(.*)$/);
        return m ? { rating: Number(m[1]), text: m[2] } : { rating: null, text: line };
      });
  } else {
    errors.push('Reviews must be text (one per line) or an array.');
    return [];
  }
  items = items.filter((i) => i.text && String(i.text).trim());
  if (items.length > LIMITS.reviews.max) {
    errors.push(`At most ${LIMITS.reviews.max} reviews per analysis.`);
    return [];
  }
  let truncated = 0;
  const out = items
    .map((i) => {
      const raw = String(i.text);
      if (raw.length > LIMITS.reviews.length) truncated++;
      const rating = i.rating === null || i.rating === undefined || i.rating === '' ? null : Number(i.rating);
      return {
        rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
        text: sanitizeText(raw, LIMITS.reviews.length),
      };
    })
    .filter((r) => r.text);
  if (truncated) warnings.push(`${truncated} review(s) were longer than ${LIMITS.reviews.length} characters and were truncated.`);
  return out;
}

export function toList(value, { max, length }) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[,\n]/)
      : [];
  return items.map((v) => sanitizeText(v, length)).filter(Boolean).slice(0, max);
}

function optionalNumber(value, label, min, max, errors) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    errors.push(`${label} must be a number between ${min} and ${max}.`);
    return null;
  }
  return n;
}

export const SOURCE_LIMITS = { urls: 10, urlLength: 2048, documents: 20, documentLength: 50_000 };

// One URL per line or comma-separated. Scheme and format are checked here; the collector checks addresses.
export function parseSourceUrls(source, errors) {
  if (source === undefined || source === null || source === '') return [];
  const items = Array.isArray(source) ? source : String(source).split(/[\n,]/);
  const urls = items.map((u) => String(u).trim()).filter(Boolean);
  if (urls.length > SOURCE_LIMITS.urls) {
    errors.push(`At most ${SOURCE_LIMITS.urls} source URLs per analysis.`);
    return [];
  }
  for (const u of urls) {
    if (u.length > SOURCE_LIMITS.urlLength) errors.push(`Source URL is longer than ${SOURCE_LIMITS.urlLength} characters.`);
    else if (!/^https?:\/\/[^\s]+$/i.test(u)) errors.push(`Source "${sanitizeText(u, 80)}" must start with http:// or https://.`);
  }
  return urls.filter((u) => /^https?:\/\//i.test(u));
}

// Documents are separated by a line of three or more dashes. A first line starting with "# " is the title.
export function parseDocuments(source, errors, warnings) {
  if (source === undefined || source === null || source === '') return [];
  const sections = Array.isArray(source)
    ? source.map((d) => String(d?.text ?? d ?? ''))
    : String(source).split(/\r?\n-{3,}\r?\n/);
  const docs = sections
    .map((section, i) => {
      const lines = section.replace(/\r/g, '').split('\n');
      let title = '';
      if (lines[0] && lines[0].startsWith('# ')) title = sanitizeText(lines.shift().slice(2), 120);
      const text = sanitizeText(lines.join('\n'), SOURCE_LIMITS.documentLength);
      if (section.length > SOURCE_LIMITS.documentLength) warnings.push(`Document ${i + 1} was truncated to ${SOURCE_LIMITS.documentLength} characters.`);
      return { title: title || `Document ${i + 1}`, text };
    })
    .filter((d) => d.text);
  if (docs.length > SOURCE_LIMITS.documents) {
    errors.push(`At most ${SOURCE_LIMITS.documents} documents per analysis.`);
    return [];
  }
  return docs;
}

// LLM settings arrive from the browser with each request. Keys are kept in memory only.
export function parseLLM(raw, errors, warnings) {
  const fallback = { provider: 'ollama', model: '', baseUrl: '', apiKey: '' };
  if (raw === undefined || raw === null) return fallback;
  if (!isPlainObject(raw)) {
    errors.push('LLM settings must be an object.');
    return fallback;
  }
  const provider = String(raw.provider ?? 'ollama');
  if (!['ollama', 'openai', 'anthropic'].includes(provider)) {
    errors.push('LLM provider must be ollama, openai or anthropic.');
    return fallback;
  }
  const baseUrl = sanitizeText(raw.baseUrl, 300);
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) errors.push('LLM base URL must start with http:// or https://.');
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, 300) : '';
  if (provider !== 'ollama' && !apiKey) warnings.push(`No API key for ${provider}; the narrative and Ask will use rule-based answers.`);
  return { provider, model: sanitizeText(raw.model, 100), baseUrl, apiKey };
}

export function validateCompanyInput(raw) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['Request body must be a JSON object.'], warnings, value: null };
  }

  const companyName = sanitizeText(raw.companyName, LIMITS.companyName);
  if (companyName.length < 2) errors.push('Company name must be at least 2 characters.');

  const requestedIndustry = sanitizeText(raw.industry, LIMITS.industry).toLowerCase();
  const industry = INDUSTRIES.includes(requestedIndustry) ? requestedIndustry : 'general';
  if (requestedIndustry && industry !== requestedIndustry) {
    warnings.push(`Industry "${requestedIndustry}" is not recognised; benchmarks use "general".`);
  }

  const currency = sanitizeText(raw.currency, 3).toUpperCase() || 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) errors.push('Currency must be a 3-letter ISO code, e.g. USD.');

  const employees = optionalNumber(raw.employees, 'Employees', 0, LIMITS.employees, errors);
  const annualRevenue = optionalNumber(raw.annualRevenue, 'Annual revenue', 0, LIMITS.annualRevenue, errors);

  const errorsBeforeMetrics = errors.length;
  const metrics = parseMetrics(raw.metrics ?? raw.metricsCsv, errors);
  if (!metrics.length && errors.length === errorsBeforeMetrics) {
    errors.push('Provide at least one month of metrics with "month" and "revenue".');
  }

  const reviews = parseReviews(raw.reviews ?? raw.reviewsText, errors, warnings);
  const sourceUrls = parseSourceUrls(raw.sourceUrls, errors);
  const documents = parseDocuments(raw.documents, errors, warnings);
  const workflow = raw.workflow === undefined ? DEFAULT_ORDER : raw.workflow;
  const flow = validateWorkflow(workflow);
  errors.push(...flow.errors);
  warnings.push(...flow.warnings);
  const llm = parseLLM(raw.llm, errors, warnings);

  if (errors.length) return { ok: false, errors, warnings, value: null };

  return {
    ok: true,
    errors,
    warnings,
    value: {
      companyName,
      industry,
      currency,
      region: sanitizeText(raw.region, LIMITS.region),
      employees,
      annualRevenue,
      goals: sanitizeText(raw.goals, LIMITS.goals),
      targetCustomers: sanitizeText(raw.targetCustomers, LIMITS.targetCustomers),
      products: toList(raw.products, LIMITS.products),
      competitors: toList(raw.competitors, LIMITS.competitors),
      metrics,
      reviews,
      sourceUrls,
      documents,
      workflow: [...workflow],
      llm,
    },
  };
}

// Output guardrail: every agent must return a summary and finite numbers only.
export function checkAgentOutput(name, output) {
  const problems = [];
  if (!output || typeof output !== 'object') {
    problems.push('no output');
    return problems;
  }
  if (typeof output.summary !== 'string' || !output.summary) problems.push('missing summary');
  const serialised = JSON.stringify(output, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? '__NON_FINITE__' : v));
  if (serialised.includes('__NON_FINITE__')) problems.push('contains NaN or Infinity');
  if (name === 'visualizer' && (!Array.isArray(output.widgets) || !Array.isArray(output.kpiTiles))) {
    problems.push('dashboard spec is missing widgets or kpiTiles');
  }
  return problems;
}

export { round };
