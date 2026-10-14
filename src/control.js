// Control agent: validates input, runs the swarm in order, passes context between agents,
// enforces timeouts and output guardrails, and streams events to subscribers.
import { EventEmitter } from 'node:events';
import { checkAgentOutput, validateCompanyInput } from './guardrails.js';
import { newId } from './util.js';
import { collectorAgent } from './agents/collector.js';
import { parserAgent } from './agents/parser.js';
import { analyzerAgent } from './agents/analyzer.js';
import { refinerAgent } from './agents/refiner.js';
import { leadgenAgent } from './agents/leadgen.js';
import { consultantAgent } from './agents/consultant.js';
import { forecasterAgent } from './agents/forecaster.js';
import { visualizerAgent } from './agents/visualizer.js';
import { AGENT_META, DEFAULT_ORDER } from './workflow.js';

const IMPLEMENTATIONS = {
  collector: { run: collectorAgent },
  parser: { run: parserAgent },
  analyzer: { run: analyzerAgent },
  refiner: { run: refinerAgent },
  leadgen: { run: leadgenAgent },
  forecaster: { run: forecasterAgent },
  consultant: { run: consultantAgent, timeoutMs: 120_000 }, // may wait on a local model
  visualizer: { run: visualizerAgent },
};

// Turns an ordered list of agent names into runnable steps. The order has already been validated.
export function buildPipeline(order) {
  return order.map((name) => ({ name, label: AGENT_META[name].label, role: AGENT_META[name].role, ...IMPLEMENTATIONS[name] }));
}

export const PIPELINE = buildPipeline(DEFAULT_ORDER);

export class GuardrailError extends Error {
  constructor(errors) {
    super('Input failed validation.');
    this.status = 400;
    this.errors = errors;
  }
}

export class CapacityError extends Error {
  constructor() {
    super('Too many analyses are running. Try again shortly.');
    this.status = 429;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class ControlAgent {
  constructor({ maxConcurrent = 3, maxJobs = 100, agentTimeoutMs = 20_000 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.maxJobs = maxJobs;
    this.agentTimeoutMs = agentTimeoutMs;
    this.jobs = new Map();
    this.bus = new EventEmitter();
    this.bus.setMaxListeners(0);
    this.active = 0;
  }

  submit(raw) {
    const verdict = validateCompanyInput(raw);
    if (!verdict.ok) throw new GuardrailError(verdict.errors);
    if (this.active >= this.maxConcurrent) throw new CapacityError();
    this.#evict();

    const pipeline = buildPipeline(verdict.value.workflow);
    const now = new Date().toISOString();
    const job = {
      id: newId(),
      status: 'queued',
      stage: null,
      createdAt: now,
      updatedAt: now,
      input: { companyName: verdict.value.companyName },
      raw,
      warnings: verdict.warnings,
      steps: pipeline,
      llm: verdict.value.llm,
      pipeline: pipeline.map(({ name, label, role }) => ({ name, label, role })),
      agents: Object.fromEntries(pipeline.map((a) => [a.name, { label: a.label, status: 'pending', ms: null, summary: null }])),
      events: [],
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.active++;
    this.#emit(job, 'job', { status: 'queued', message: 'Accepted by control agent' });
    setImmediate(() => {
      this.#run(job, verdict.value).finally(() => {
        this.active--;
      });
    });
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  snapshot(job) {
    return {
      id: job.id,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      input: job.input,
      warnings: job.warnings,
      pipeline: job.pipeline,
      agents: job.agents,
      error: job.error,
      events: job.events.slice(-100),
    };
  }

  async #run(job, input) {
    const ctx = { input, stages: job.steps.map((s) => s.name) };
    job.status = 'running';
    this.#emit(job, 'job', { status: 'running', message: 'Swarm started' });

    for (const agent of job.steps) {
      const state = job.agents[agent.name];
      job.stage = agent.name;
      state.status = 'running';
      this.#emit(job, 'agent', { agent: agent.name, status: 'running', message: `${agent.label} started` });

      const started = performance.now();
      try {
        const output = await this.#runAgent(agent, ctx);
        ctx[agent.name] = output;
        Object.assign(state, { status: 'done', ms: Math.round(performance.now() - started), summary: output.summary });
        this.#emit(job, 'agent', { agent: agent.name, status: 'done', ms: state.ms, message: output.summary });
      } catch (err) {
        Object.assign(state, { status: 'failed', ms: Math.round(performance.now() - started), summary: err.message });
        this.#emit(job, 'agent', { agent: agent.name, status: 'failed', ms: state.ms, message: err.message });
        job.status = 'failed';
        job.error = `${agent.label} failed: ${err.message}`;
        this.#emit(job, 'job', { status: 'failed', message: job.error });
        this.#finish(job);
        return;
      }
    }

    job.result = { ...ctx.visualizer, warnings: [...job.warnings, ...ctx.visualizer.warnings] };
    job.stage = 'done';
    job.status = 'completed';
    this.#emit(job, 'job', { status: 'completed', message: 'Dashboard ready' });
    this.#finish(job);
  }

  // One retry for transient failures; output guardrails run on every attempt.
  async #runAgent(agent, ctx) {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const output = await withTimeout(agent.run(ctx), agent.timeoutMs ?? this.agentTimeoutMs, agent.label);
        const problems = checkAgentOutput(agent.name, output);
        if (problems.length) throw new Error(`output guardrail: ${problems.join(', ')}`);
        return output;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  #emit(job, type, data) {
    const event = { seq: job.events.length + 1, at: new Date().toISOString(), type, ...data };
    job.events.push(event);
    job.updatedAt = event.at;
    this.bus.emit(job.id, event);
  }

  #finish(job) {
    this.#emit(job, 'end', { status: job.status });
  }

  #evict() {
    if (this.jobs.size < this.maxJobs) return;
    for (const [id, job] of this.jobs) {
      if (job.status === 'completed' || job.status === 'failed') {
        this.jobs.delete(id);
        return;
      }
    }
  }
}
