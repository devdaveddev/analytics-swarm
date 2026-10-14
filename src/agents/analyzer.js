// Agent 2 — Analyzer: derives KPIs per month, period trends and anomalies.
import { linreg, mean, pct, round, safeDiv, stdev } from '../util.js';

function trend(values) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const { slope } = linreg(v);
  const m = mean(v);
  return {
    first: v[0],
    last: v[v.length - 1],
    changePct: pct(v[v.length - 1], v[0]),
    slopePct: m ? round((slope / m) * 100, 2) : null,
    direction: slope > 0 ? 'up' : slope < 0 ? 'down' : 'flat',
  };
}

const fmtPct = (v) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v}%`);

export async function analyzerAgent(ctx) {
  const rows = ctx.parser.metrics;

  const series = rows.map((r, i) => {
    const prev = rows[i - 1];
    const newCustomers =
      prev && r.customers !== null && prev.customers !== null
        ? Math.max(r.customers - prev.customers + (r.churned ?? 0), 0)
        : null;
    return {
      month: r.month,
      revenue: r.revenue,
      customers: r.customers,
      newCustomers,
      leads: r.leads,
      conversions: r.conversions,
      marketingSpend: r.marketing_spend,
      churned: r.churned,
      churnRate: prev ? safeDiv(r.churned, prev.customers) : null,
      arpu: safeDiv(r.revenue, r.customers),
      cac: safeDiv(r.marketing_spend, newCustomers),
      conversionRate: safeDiv(r.conversions, r.leads),
      costPerLead: safeDiv(r.marketing_spend, r.leads),
    };
  });

  const trends = {
    revenue: trend(series.map((s) => s.revenue)),
    customers: trend(series.map((s) => s.customers)),
    cac: trend(series.map((s) => s.cac)),
    conversionRate: trend(series.map((s) => s.conversionRate)),
  };

  const anomalies = [];
  if (series.length >= 4) {
    for (const field of ['revenue', 'customers', 'costPerLead']) {
      const nums = series.map((s) => s[field]).filter((x) => x != null);
      const sd = stdev(nums);
      const m = mean(nums);
      if (!sd) continue;
      series.forEach((s) => {
        if (s[field] == null) return;
        const z = (s[field] - m) / sd;
        if (Math.abs(z) >= 2) anomalies.push({ month: s.month, metric: field, z: round(z, 2) });
      });
    }
  }

  const latest = series.at(-1);
  return {
    summary: `Analyzed ${series.length} month(s): revenue ${fmtPct(trends.revenue?.changePct)} over the period, ${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'} flagged.`,
    series,
    latest,
    trends,
    anomalies,
  };
}
