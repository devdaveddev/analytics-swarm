// Agent 7 — Visualizer: turns all upstream results into a dashboard spec the browser renders interactively.
import { ASPECTS } from '../sentiment.js';

const toneFor = (v, threshold) => (v == null ? 'neutral' : v > threshold ? 'good' : v < -threshold ? 'bad' : 'neutral');
const higherIsBetter = (v, target) => (v == null ? 'neutral' : v >= target ? 'good' : v < target * 0.7 ? 'bad' : 'neutral');
const lowerIsBetter = (v, target) => (v == null ? 'neutral' : v <= target ? 'good' : v > target * 1.5 ? 'bad' : 'neutral');
const cacTone = (cac, arpu) => {
  if (cac == null || !arpu) return 'neutral';
  const payback = cac / arpu;
  return payback <= 6 ? 'good' : payback > 12 ? 'bad' : 'neutral';
};
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const TONE = { positive: 'good', neutral: 'neutral', negative: 'bad' };

// Insight metric -> KPI node it refers to.
const METRIC_NODE = { revenue: 'kpi-revenue', churnRate: 'kpi-churn', cac: 'kpi-cac', conversionRate: 'kpi-conversion' };

// Lays out graph nodes in four columns: feature areas -> KPIs -> insights -> recommendations.
function buildGraph(kpiNodes, consultant, refiner) {
  const aspectNodes = consultant.aspects.map((a) => ({
    id: `asp-${a.key}`,
    label: a.label,
    group: 'aspect',
    col: 0,
    tone: a.net > 0.15 ? 'good' : a.net < -0.15 ? 'bad' : 'neutral',
    detail: `${a.mentions} mention(s), net ${a.net}`,
  }));
  const insightNodes = refiner.insights.slice(0, 10).map((i, n) => ({
    id: `ins-${n}`,
    label: i.title,
    group: 'insight',
    col: 2,
    tone: i.severity === 'positive' ? 'good' : i.severity === 'critical' ? 'bad' : i.severity === 'warning' ? 'warning' : 'neutral',
    detail: i.detail,
    metric: i.metric,
  }));
  const recs = consultant.recommendations.slice(0, 12);
  const recNodes = recs.map((r, n) => ({
    id: `rec-${n}`,
    label: r.action,
    group: 'recommendation',
    col: 3,
    tone: 'accent',
    detail: `${r.area} · effort ${r.effort}`,
    area: r.area,
  }));

  const edges = [];
  for (const rec of recNodes) {
    for (const asp of aspectNodes) {
      if (rec.area === asp.label) edges.push({ from: asp.id, to: rec.id, kind: 'addresses' });
    }
  }
  for (const ins of insightNodes) {
    const kpi = METRIC_NODE[ins.metric];
    if (kpi && kpiNodes.some((k) => k.id === kpi)) edges.push({ from: kpi, to: ins.id, kind: 'signals' });
    recNodes.forEach((rec) => {
      if (rec.label.includes(ins.label)) edges.push({ from: ins.id, to: rec.id, kind: 'drives' });
    });
  }

  const nodes = [...aspectNodes, ...kpiNodes, ...insightNodes, ...recNodes];
  const byCol = {};
  for (const n of nodes) (byCol[n.col] ??= []).push(n);
  for (const col of Object.values(byCol)) {
    col.forEach((n, i) => {
      n.x = n.col / 3;
      n.y = (i + 1) / (col.length + 1);
    });
  }
  return { nodes, edges, columns: ['Feature areas', 'KPIs', 'Insights', 'Actions'] };
}

export async function visualizerAgent(ctx) {
  // Optional agents may be removed or reordered in the workflow, so each has a safe fallback.
  const { input, parser, refiner, consultant } = ctx;
  const leadgen = ctx.leadgen ?? null;
  const forecaster = ctx.forecaster ?? null;
  const collector = ctx.collector ?? { documents: [], sources: [] };
  const k = refiner.kpis;
  const bm = parser.benchmarks;

  const kpi = (label, value, format, extra = {}) => ({
    label,
    value: value ?? null,
    format,
    delta: extra.delta ?? null,
    deltaLabel: extra.deltaLabel ?? null,
    tone: extra.tone ?? 'neutral',
  });

  const kpiTiles = [
    kpi('Monthly revenue', k.revenue, 'currency', { delta: k.revenueChangePct, deltaLabel: 'over period', tone: toneFor(k.revenueChangePct, 1) }),
    kpi('Customers', k.customers, 'number', { delta: k.customersChangePct, deltaLabel: 'over period', tone: toneFor(k.customersChangePct, 1) }),
    kpi('ARPU (monthly)', k.arpu, 'currency'),
    kpi('Churn (monthly)', k.churnRate, 'percent', { tone: lowerIsBetter(k.churnRate, bm.churnMonthly) }),
    kpi('Acquisition cost (CAC)', k.cac, 'currency', { tone: cacTone(k.cac, k.arpu) }),
    kpi('Lead → customer', k.conversionRate, 'percent', { tone: higherIsBetter(k.conversionRate, bm.conversionRate) }),
    kpi('Net review sentiment', consultant.sentiment.average, 'signed', { tone: toneFor(consultant.sentiment.average, 0.05) }),
  ];

  const aspectLabels = Object.fromEntries(Object.entries(ASPECTS).map(([key, a]) => [key, a.label]));

  const kpiNodes = [
    { id: 'kpi-revenue', label: 'Monthly revenue', group: 'kpi', col: 1, tone: kpiTiles[0].tone, detail: `${k.revenue ?? 'n/a'}` },
    { id: 'kpi-churn', label: 'Churn', group: 'kpi', col: 1, tone: kpiTiles[3].tone, detail: `${k.churnRate ?? 'n/a'}` },
    { id: 'kpi-cac', label: 'CAC', group: 'kpi', col: 1, tone: kpiTiles[4].tone, detail: `${k.cac ?? 'n/a'}` },
    { id: 'kpi-conversion', label: 'Lead → customer', group: 'kpi', col: 1, tone: kpiTiles[5].tone, detail: `${k.conversionRate ?? 'n/a'}` },
  ];

  const documents = collector.documents.map((d) => ({
    title: d.title,
    words: d.words,
    sentiment: d.sentiment,
    summary: d.summary,
    facts: d.facts,
    topTerms: d.topTerms,
    aspects: Object.keys(d.aspects),
    flagged: d.flagged,
  }));

  const widgets = [
    {
      id: 'revenue-trend',
      type: 'line',
      size: 'wide',
      title: 'Revenue over time',
      format: 'currency',
      series: [{ name: 'Revenue', points: refiner.series.map((s) => ({ x: s.month, y: s.revenue })) }],
    },
    ...(forecaster?.points.length
      ? [{
          id: 'forecast',
          type: 'forecast',
          size: 'wide',
          title: 'Revenue outlook (linear trend, next 3 months)',
          format: 'currency',
          points: forecaster.points,
          note: 'A straight-line trend with a band of one standard deviation of past residuals. It is not a seasonal forecast.',
        }]
      : []),
    {
      id: 'graph',
      type: 'graph',
      size: 'wide',
      title: 'How the findings connect',
      ...buildGraph(kpiNodes, consultant, refiner),
    },
    ...(leadgen
      ? [{
          id: 'funnel',
          type: 'funnel',
          size: 'half',
          title: 'Lead funnel',
          stages: leadgen.funnel.map((s) => ({ label: s.label, value: s.value, rate: s.rate ?? null })),
          footnote: leadgen.weakestStage ? `Weakest stage: ${leadgen.weakestStage.label.toLowerCase()}` : null,
        }]
      : []),
    {
      id: 'sentiment',
      type: 'donut',
      size: 'half',
      title: 'Review sentiment',
      interactive: 'sentiment',
      slices: ['positive', 'neutral', 'negative'].map((key) => ({
        key,
        label: capitalise(key),
        value: consultant.sentiment.distribution[key],
        tone: TONE[key],
      })),
    },
    {
      id: 'aspects',
      type: 'bars',
      size: 'half',
      title: 'Sentiment by feature area',
      interactive: 'aspect',
      bars: consultant.aspects.map((a) => ({
        key: a.key,
        label: a.label,
        value: a.net,
        mentions: a.mentions,
        tone: a.net > 0.15 ? 'good' : a.net < -0.15 ? 'bad' : 'neutral',
      })),
    },
    {
      id: 'insights',
      type: 'insights',
      size: 'half',
      title: 'Key insights',
      items: refiner.insights.map((i) => ({ severity: i.severity, title: i.title, detail: i.detail })),
    },
    {
      id: 'recommendations',
      type: 'table',
      size: 'wide',
      title: 'Prioritised improvements & lead-generation moves',
      columns: ['#', 'Area', 'Action', 'Effort'],
      rows: consultant.recommendations.map((r, i) => [String(i + 1), r.area, r.action, r.effort]),
      voteAreas: consultant.recommendations.map((r) => r.area),
    },
    {
      id: 'documents',
      type: 'documents',
      size: 'wide',
      title: 'Analysed documents',
      items: documents,
    },
    {
      id: 'sources',
      type: 'table',
      size: 'half',
      title: 'Live sources',
      columns: ['Source', 'Status', 'Items', 'Detail'],
      rows: collector.sources.map((s) => [s.url, s.status, String(s.count), s.error ?? s.kind]),
    },
    {
      id: 'reviews',
      type: 'reviews',
      size: 'wide',
      title: 'Customer reviews',
      aspectLabels,
      items: consultant.reviews.slice(0, 200).map((r, idx) => ({
        id: idx,
        text: r.text,
        rating: r.rating,
        label: r.label,
        score: r.score,
        flagged: r.injection,
        aspects: Object.keys(r.aspects),
      })),
    },
    ...(ctx.stages ?? [])
      .filter((id) => id.startsWith('custom-') && ctx[id])
      .map((id) => ({
        id,
        type: 'text',
        size: 'wide',
        custom: true,
        title: ctx[id].title,
        body: ctx[id].text || ctx[id].note || ctx[id].summary,
      })),
    {
      id: 'summary',
      type: 'text',
      size: 'wide',
      title: 'Consultant summary',
      body:
        consultant.narrative ??
        `Rule-based analysis complete. ${consultant.llmStatus === 'disabled' ? 'Narrative is off (OLLAMA_DISABLED=1).' : `Narrative status: ${consultant.llmStatus}.`}`,
    },
  ];

  const warnings = [
    ...parser.dataQuality.issues,
    ...refiner.corrections.map((c) => `${c.month}: ${c.action}`),
    ...collector.sources.filter((s) => s.status === 'error').map((s) => `Source ${s.url}: ${s.error}`),
  ];

  return {
    summary: `Built ${widgets.length} widgets and ${kpiTiles.length} KPI tiles for ${input.companyName}.`,
    title: `${input.companyName} — Business analytics`,
    generatedAt: new Date().toISOString(),
    currency: input.currency,
    confidence: refiner.confidence,
    kpiTiles,
    widgets,
    warnings,
    meta: {
      stages: ctx.stages ?? [],
      llm: consultant.llmStatus,
    },
  };
}
