// Illustrative planning defaults per industry. Replace with your own benchmark data before relying on them.
export const BENCHMARKS = {
  saas: { churnMonthly: 0.03, conversionRate: 0.2, costPerLead: 90 },
  ecommerce: { churnMonthly: 0.07, conversionRate: 0.03, costPerLead: 25 },
  retail: { churnMonthly: 0.05, conversionRate: 0.04, costPerLead: 20 },
  services: { churnMonthly: 0.02, conversionRate: 0.15, costPerLead: 60 },
  manufacturing: { churnMonthly: 0.01, conversionRate: 0.08, costPerLead: 120 },
  healthcare: { churnMonthly: 0.02, conversionRate: 0.12, costPerLead: 80 },
  fintech: { churnMonthly: 0.04, conversionRate: 0.06, costPerLead: 110 },
  general: { churnMonthly: 0.04, conversionRate: 0.08, costPerLead: 50 },
};
