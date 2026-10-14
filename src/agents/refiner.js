// Agent 3 — Refiner: corrects impossible values, scores confidence and ranks insights against benchmarks.
import { clamp, round } from '../util.js';

const ORDER = { critical: 0, warning: 1, info: 2, positive: 3 };
const pc = (v) => `${(v * 100).toFixed(1)}%`;
const money = (cur, v) => `${cur} ${Math.round(v).toLocaleString('en-US')}`;

export async function refinerAgent(ctx) {
  const { analyzer, parser, input } = ctx;
  const bm = parser.benchmarks;
  const corrections = [];

  const series = analyzer.series.map((row, i) => {
    const r = { ...row };
    if (r.conversionRate !== null && r.conversionRate > 1) {
      corrections.push({ month: r.month, field: 'conversionRate', action: `clipped ${r.conversionRate} to 1 (conversions exceed leads)` });
      r.conversionRate = 1;
    }
    if (r.churnRate !== null && r.churnRate > 1) {
      corrections.push({ month: r.month, field: 'churnRate', action: 'clipped to 100% (churned exceeds prior customers)' });
      r.churnRate = 1;
    }
    const prev = analyzer.series[i - 1];
    if (prev && prev.customers !== null && r.customers !== null && r.churned !== null && r.customers - prev.customers + r.churned < 0) {
      corrections.push({ month: r.month, field: 'customers', action: 'customer count fell by more than reported churn; check churn figures' });
    }
    return r;
  });

  const n = series.length;
  let confidence = n >= 6 ? 0.9 : n >= 3 ? 0.75 : n === 2 ? 0.5 : 0.3;
  confidence -= 0.05 * corrections.length;
  confidence *= 0.5 + 0.5 * (parser.dataQuality.score / 100);
  confidence = round(clamp(confidence, 0.1, 0.95), 2);

  const last = series.at(-1);
  const kpis = {
    revenue: last.revenue,
    customers: last.customers,
    arpu: last.arpu,
    churnRate: last.churnRate,
    cac: last.cac,
    conversionRate: last.conversionRate,
    costPerLead: last.costPerLead,
    revenueChangePct: analyzer.trends.revenue?.changePct ?? null,
    customersChangePct: analyzer.trends.customers?.changePct ?? null,
  };

  const insights = [];
  const add = (severity, title, detail, metric) => insights.push({ severity, title, detail, metric });
  const cur = input.currency;

  const rev = analyzer.trends.revenue;
  if (rev && rev.changePct !== null) {
    if (rev.changePct < -5) {
      add('critical', 'Revenue is declining', `Revenue moved ${rev.changePct}% across the period (${money(cur, rev.first)} → ${money(cur, rev.last)}).`, 'revenue');
    } else if (rev.changePct > 10) {
      add('positive', 'Revenue is growing', `Revenue grew ${rev.changePct}% across the period (${money(cur, rev.first)} → ${money(cur, rev.last)}).`, 'revenue');
    }
  }

  if (kpis.churnRate !== null) {
    if (kpis.churnRate > bm.churnMonthly * 2) {
      add('critical', 'Churn is more than double the benchmark', `Latest monthly churn is ${pc(kpis.churnRate)} vs about ${pc(bm.churnMonthly)} for ${bm.industry}.`, 'churnRate');
    } else if (kpis.churnRate > bm.churnMonthly * 1.2) {
      add('warning', 'Churn is above benchmark', `Latest monthly churn is ${pc(kpis.churnRate)} vs about ${pc(bm.churnMonthly)} for ${bm.industry}.`, 'churnRate');
    }
  }

  if (kpis.conversionRate !== null && kpis.conversionRate < bm.conversionRate * 0.7) {
    add('warning', 'Lead conversion is below benchmark', `Lead-to-conversion is ${pc(kpis.conversionRate)} vs about ${pc(bm.conversionRate)} for ${bm.industry}.`, 'conversionRate');
  }

  if (kpis.cac !== null && kpis.arpu) {
    const payback = kpis.cac / kpis.arpu;
    if (payback > 12) {
      add('critical', 'CAC payback exceeds 12 months', `Acquiring a customer costs about ${payback.toFixed(1)} months of revenue per customer.`, 'cac');
    } else if (payback > 6) {
      add('warning', 'CAC payback is long', `Acquiring a customer costs about ${payback.toFixed(1)} months of revenue per customer.`, 'cac');
    }
  }

  for (const a of analyzer.anomalies) {
    add('info', `Unusual ${a.metric} in ${a.month}`, `Value is ${a.z} standard deviations from the period mean.`, a.metric);
  }
  for (const issue of parser.dataQuality.issues) add('info', 'Data quality', issue, 'data');

  insights.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const critical = insights.filter((i) => i.severity === 'critical').length;

  return {
    summary: `Refined ${n} month(s) with ${corrections.length} correction(s); confidence ${Math.round(confidence * 100)}%; ${insights.length} insight(s), ${critical} critical.`,
    series,
    kpis,
    confidence,
    corrections,
    insights,
  };
}
