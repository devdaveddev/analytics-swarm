// Agent 4 — Lead generation & marketing analytics: funnel, channel fit, spend efficiency and keyword focus.
import { safeDiv, topKeywords } from '../util.js';

const CHANNELS = {
  saas: ['LinkedIn outreach', 'Search content (SEO)', 'Free trial / product-led growth', 'Webinars and demos'],
  ecommerce: ['Paid social', 'Email and SMS retention', 'Marketplace listings', 'Influencer partnerships'],
  retail: ['Local search ads', 'Loyalty programme', 'In-store promotions', 'Social video'],
  services: ['Referral programme', 'Local SEO and Google Business Profile', 'Case-study content'],
  manufacturing: ['Trade shows', 'Distributor partnerships', 'LinkedIn', 'Technical SEO'],
  healthcare: ['Referrals', 'Local search', 'Patient-education content'],
  fintech: ['Partnerships', 'Comparison-site listings', 'Content SEO'],
  general: ['Referrals', 'Email nurture', 'Search ads', 'Social media'],
};


const num = (v) => (v == null ? 'n/a' : Math.round(v).toLocaleString('en-US'));

export async function leadgenAgent(ctx) {
  const { refiner, parser, input } = ctx;
  const bm = parser.benchmarks;
  const latest = refiner.series.at(-1);

  const funnel = [
    { label: 'Leads', value: latest.leads },
    { label: 'Conversions', value: latest.conversions, rate: safeDiv(latest.conversions, latest.leads) },
    { label: 'New customers', value: latest.newCustomers, rate: safeDiv(latest.newCustomers, latest.conversions) },
  ];
  const stageRates = funnel.slice(1).filter((s) => s.rate !== null);
  const weakestStage = stageRates.length ? stageRates.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;

  const efficiency = {
    marketingSpend: latest.marketingSpend,
    costPerLead: latest.costPerLead,
    costPerLeadBenchmark: bm.costPerLead,
    costPerAcquisition: latest.cac,
    spendShareOfRevenue: safeDiv(latest.marketingSpend, latest.revenue),
  };

  const actions = [];
  if (latest.costPerLead !== null && latest.costPerLead > bm.costPerLead * 1.3) {
    actions.push({
      area: 'Paid acquisition',
      action: 'Cost per lead is more than 30% above the benchmark. Pause the lowest-converting campaigns and move budget to the best-performing channel.',
      effort: 'low',
      impact: 1.5,
    });
  }
  if (funnel[1].rate !== null && funnel[1].rate < bm.conversionRate) {
    actions.push({
      area: 'Lead qualification',
      action: 'Lead-to-conversion is below the benchmark. Add a qualification step (budget, timeline, use case) before sales follow-up.',
      effort: 'medium',
      impact: 1.2,
    });
  }
  if (efficiency.spendShareOfRevenue !== null && efficiency.spendShareOfRevenue > 0.3) {
    actions.push({
      area: 'Marketing budget',
      action: 'Marketing spend exceeds 30% of revenue. Set a payback target and cap spend by channel until CAC improves.',
      effort: 'low',
      impact: 1,
    });
  }

  const icpSource = [parser.company.targetCustomers, parser.company.goals, ...parser.company.products].join(' ');
  const focus = topKeywords(icpSource, 8);
  const channels = CHANNELS[bm.industry] ?? CHANNELS.general;

  return {
    summary: `Funnel: ${num(latest.leads)} leads → ${num(latest.conversions)} conversions → ${num(latest.newCustomers)} new customers; ${actions.length} lead-generation action(s).`,
    funnel,
    weakestStage,
    efficiency,
    icp: parser.company.targetCustomers || 'Not provided. Add a target-customer description to sharpen lead targeting.',
    keywords: focus,
    channels,
    actions,
    currency: input.currency,
  };
}
