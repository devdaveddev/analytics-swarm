// Workflow rules: which agents exist, what each needs, and which orders are valid.
// Used by the control agent (to reject bad orders) and by the Agents page (to guide editing).
//   requires:  hard dependencies. They must be in the workflow and run earlier, or the agent cannot work.
//   softAfter: optional inputs. Running earlier is allowed, but the agent will not use that output.
//   optional:  can be removed from the workflow.
export const AGENT_META = {
  collector: {
    label: 'Collector',
    role: 'Live-fetches source URLs and analyses pasted documents',
    requires: [],
    softAfter: [],
    optional: true,
  },
  parser: {
    label: 'Parser & Researcher',
    role: 'Parses input, redacts PII, attaches benchmarks, checks data quality',
    requires: [],
    softAfter: ['collector'],
    optional: false,
  },
  analyzer: {
    label: 'Analyzer',
    role: 'Computes KPIs per month, period trends and anomalies',
    requires: ['parser'],
    softAfter: [],
    optional: false,
  },
  refiner: {
    label: 'Refiner',
    role: 'Corrects impossible values, scores confidence, ranks insights',
    requires: ['analyzer', 'parser'],
    softAfter: [],
    optional: false,
  },
  leadgen: {
    label: 'Lead Generation & Marketing',
    role: 'Funnel, channel fit, spend efficiency, lead-gen actions',
    requires: ['refiner'],
    softAfter: [],
    optional: true,
  },
  forecaster: {
    label: 'Forecaster',
    role: 'Projects revenue three months ahead with a trend band',
    requires: ['refiner'],
    softAfter: [],
    optional: true,
  },
  consultant: {
    label: 'Consultant',
    role: 'Review sentiment, market gaps, prioritised improvements',
    requires: ['parser', 'refiner'],
    softAfter: ['leadgen'],
    optional: false,
  },
  visualizer: {
    label: 'Visualizer',
    role: 'Builds the interactive dashboard specification',
    requires: ['parser', 'refiner', 'consultant'],
    softAfter: ['collector', 'leadgen', 'forecaster'],
    optional: false,
  },
};

export const DEFAULT_ORDER = ['collector', 'parser', 'analyzer', 'refiner', 'leadgen', 'forecaster', 'consultant', 'visualizer'];

export function validateWorkflow(order) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(order) || order.length === 0 || order.length > 20) {
    return { ok: false, errors: ['Workflow must be a list of 1 to 20 agent names.'], warnings };
  }

  const seen = new Set();
  for (const name of order) {
    if (typeof name !== 'string' || !Object.hasOwn(AGENT_META, name)) {
      errors.push(`Unknown agent "${String(name).slice(0, 40)}".`);
    } else if (seen.has(name)) {
      errors.push(`${AGENT_META[name].label} appears more than once.`);
    }
    seen.add(name);
  }
  if (errors.length) return { ok: false, errors, warnings };

  for (const [name, meta] of Object.entries(AGENT_META)) {
    if (!meta.optional && !seen.has(name)) errors.push(`${meta.label} is required and cannot be removed.`);
  }

  const position = new Map(order.map((name, i) => [name, i]));
  for (const name of order) {
    const meta = AGENT_META[name];
    for (const dep of meta.requires) {
      if (!position.has(dep)) errors.push(`${meta.label} needs ${AGENT_META[dep].label}, which is not in the workflow.`);
      else if (position.get(dep) > position.get(name)) errors.push(`${meta.label} must run after ${AGENT_META[dep].label}.`);
    }
    for (const dep of meta.softAfter) {
      if (position.has(dep) && position.get(dep) > position.get(name)) {
        warnings.push(`${meta.label} runs before ${AGENT_META[dep].label}, so it will not use that output.`);
      }
    }
  }
  if (order.at(-1) !== 'visualizer') errors.push('Visualizer must be the last step.');

  return { ok: errors.length === 0, errors, warnings };
}

export const workflowMeta = () => ({
  defaultOrder: DEFAULT_ORDER,
  agents: Object.entries(AGENT_META).map(([name, m]) => ({ name, ...m })),
});
