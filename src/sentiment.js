// Lexicon-based sentiment with negation and intensifiers, plus feature-area (aspect) tagging.
import { mean, round } from './util.js';

export const ASPECTS = {
  price: {
    label: 'Pricing',
    words: ['price', 'pricing', 'cost', 'costs', 'expensive', 'cheap', 'value', 'fee', 'fees', 'subscription', 'plan', 'plans'],
  },
  quality: {
    label: 'Product quality',
    words: ['quality', 'broke', 'broken', 'durable', 'sturdy', 'flimsy', 'defect', 'defective', 'build', 'solid'],
  },
  support: {
    label: 'Customer support',
    words: ['support', 'service', 'agent', 'agents', 'response', 'helpdesk', 'refund', 'team', 'help'],
  },
  delivery: {
    label: 'Delivery & shipping',
    words: ['shipping', 'delivery', 'delivered', 'late', 'arrived', 'package', 'shipment', 'carrier'],
  },
  usability: {
    label: 'Ease of use',
    words: ['easy', 'intuitive', 'interface', 'confusing', 'complicated', 'simple', 'ux', 'setup', 'onboarding', 'docs', 'documentation', 'guide', 'permissions', 'navigate'],
  },
  performance: {
    label: 'Speed & reliability',
    words: ['slow', 'slowly', 'fast', 'lag', 'laggy', 'crash', 'crashes', 'crashed', 'bug', 'bugs', 'buggy', 'reliable', 'reliability', 'downtime', 'load', 'loads', 'stable'],
  },
  features: {
    label: 'Features & integrations',
    words: ['feature', 'features', 'integration', 'integrations', 'missing', 'option', 'options', 'request', 'requests', 'roadmap', 'connector', 'connectors', 'app', 'mobile'],
  },
};

const POSITIVE = new Set([
  'good', 'great', 'excellent', 'love', 'loved', 'like', 'liked', 'amazing', 'awesome', 'fantastic', 'helpful', 'fast',
  'easy', 'reliable', 'solid', 'happy', 'recommend', 'recommended', 'best', 'nice', 'smooth', 'intuitive', 'friendly',
  'perfect', 'worth', 'impressive', 'quick', 'responsive', 'beautiful', 'enjoy', 'enjoyed', 'satisfied', 'pleased',
  'value', 'sturdy', 'durable', 'works', 'improved', 'useful', 'clean', 'affordable', 'convenient', 'fair', 'polite',
  'pleasant', 'stable', 'saves', 'save',
]);

const NEGATIVE = new Set([
  'bad', 'poor', 'terrible', 'awful', 'horrible', 'hate', 'hated', 'worst', 'broken', 'broke', 'buggy', 'bug', 'bugs',
  'slow', 'slowly', 'late', 'delay', 'delayed', 'expensive', 'overpriced', 'confusing', 'confused', 'difficult',
  'annoying', 'frustrating', 'frustrated', 'useless', 'rude', 'unhelpful', 'crash', 'crashes', 'crashed', 'missing',
  'lacking', 'lag', 'laggy', 'defect', 'defective', 'flimsy', 'disappointed', 'disappointing', 'refund', 'scam', 'waste',
  'wasted', 'error', 'errors', 'fail', 'failed', 'failure', 'problem', 'problems', 'issue', 'issues', 'complicated',
  'unreliable', 'downtime', 'damaged', 'worse', 'regret', 'painfully', 'outdated',
]);

const NEGATORS = new Set(['not', 'no', 'never', 'dont', 'didnt', 'doesnt', 'isnt', 'wasnt', 'arent', 'cant', 'wont', 'hardly', 'without']);
const INTENSIFIERS = new Map(
  Object.entries({ very: 1.5, really: 1.4, extremely: 1.8, super: 1.4, so: 1.2, too: 1.2, quite: 1.1, slightly: 0.6, somewhat: 0.7, bit: 0.7, little: 0.7 }),
);

export const tokenize = (text) => String(text).toLowerCase().replace(/'/g, '').match(/[a-z]+/g) ?? [];

// Per-word adjustments learned from user label corrections (see feedback.js).
let learned = {};
export const setLearnedWeights = (weights) => {
  learned = { ...weights };
};
export const getLearnedWeights = () => ({ ...learned });

const lexiconValue = (tok) => (POSITIVE.has(tok) ? 1 : NEGATIVE.has(tok) ? -1 : 0);
const LABEL_TARGET = { positive: 0.6, neutral: 0, negative: -0.6 };

// Moves each word's weight toward the user's label. Long reviews move each word less.
export function learnFromReview(text, label) {
  if (!(label in LABEL_TARGET)) throw new Error(`Unknown label: ${label}`);
  const tokens = tokenize(text).filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const predicted = scoreText(text).score;
  const step = 0.25 / Math.sqrt(tokens.length);
  const error = LABEL_TARGET[label] - predicted;
  for (const tok of new Set(tokens)) {
    const next = (learned[tok] ?? 0) + step * error;
    learned[tok] = round(Math.max(-1, Math.min(1, next)), 4);
  }
  return new Set(tokens).size;
}

export function scoreTokens(tokens) {
  let sum = 0;
  let hits = 0;
  tokens.forEach((tok, i) => {
    const base = Math.max(-1, Math.min(1, lexiconValue(tok) + (learned[tok] ?? 0)));
    if (!base) return;
    hits++;
    let weight = 1;
    const near = tokens.slice(Math.max(0, i - 3), i);
    for (const w of near) if (INTENSIFIERS.has(w)) weight *= INTENSIFIERS.get(w);
    if (near.some((w) => NEGATORS.has(w))) weight *= -0.8;
    sum += base * weight;
  });
  return { score: round(Math.tanh(sum / 2), 3), hits };
}

export const scoreText = (text) => scoreTokens(tokenize(text));

export const labelOf = (score) => (score > 0.15 ? 'positive' : score < -0.15 ? 'negative' : 'neutral');

// Returns { aspectKey: averageSentenceScore } for every feature area mentioned in the text.
export function aspectSentiments(text) {
  const buckets = {};
  for (const sentence of String(text).split(/[.!?;\n]+/)) {
    const tokens = tokenize(sentence);
    if (!tokens.length) continue;
    const { score } = scoreTokens(tokens);
    for (const [key, { words }] of Object.entries(ASPECTS)) {
      if (tokens.some((t) => words.includes(t))) (buckets[key] ??= []).push(score);
    }
  }
  return Object.fromEntries(Object.entries(buckets).map(([k, scores]) => [k, round(mean(scores), 3)]));
}
