// Feedback loop. Two signals are stored and fed back into the next analysis:
//  - review label corrections nudge per-word sentiment weights (the lexicon learns);
//  - helpful / not-helpful votes on recommendations scale that feature area's priority.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLearnedWeights, learnFromReview, setLearnedWeights } from './sentiment.js';
import { clamp, round } from './util.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let FILE = path.join(process.env.DATA_DIR || path.join(ROOT, '..', 'data'), 'feedback.json');

// Point the store at another file (used by tests so they never touch real data).
export function useFeedbackFile(file) {
  FILE = file;
}

const state = {
  areaMultipliers: {},
  corrections: 0,
  votes: { helpful: 0, notHelpful: 0 },
  updatedAt: null,
};
let saving = Promise.resolve();

export async function loadFeedback() {
  try {
    const saved = JSON.parse(await readFile(FILE, 'utf8'));
    state.areaMultipliers = saved.areaMultipliers ?? {};
    state.corrections = saved.corrections ?? 0;
    state.votes = saved.votes ?? state.votes;
    state.updatedAt = saved.updatedAt ?? null;
    setLearnedWeights(saved.weights ?? {});
  } catch {
    // No feedback yet: start from the built-in lexicon.
  }
}

function persist() {
  state.updatedAt = new Date().toISOString();
  const payload = { ...state, weights: getLearnedWeights() };
  saving = saving
    .then(() => mkdir(path.dirname(FILE), { recursive: true }))
    .then(() => writeFile(FILE, JSON.stringify(payload, null, 2)))
    .catch((err) => console.error('Could not save feedback:', err.message));
  return saving;
}

// Returns how many words were adjusted.
export function recordReviewCorrection(text, label) {
  const changed = learnFromReview(text, label);
  state.corrections++;
  persist();
  return changed;
}

export function recordRecommendationVote(area, helpful) {
  const current = state.areaMultipliers[area] ?? 1;
  state.areaMultipliers[area] = round(clamp(current * (helpful ? 1.1 : 0.9), 0.5, 1.5), 3);
  state.votes[helpful ? 'helpful' : 'notHelpful']++;
  persist();
  return state.areaMultipliers[area];
}

export const areaMultiplier = (area) => state.areaMultipliers[area] ?? 1;

export function feedbackStats() {
  return {
    corrections: state.corrections,
    votes: state.votes,
    learnedWords: Object.keys(getLearnedWeights()).length,
    areaMultipliers: state.areaMultipliers,
    updatedAt: state.updatedAt,
  };
}

export function resetFeedbackForTests() {
  state.areaMultipliers = {};
  state.corrections = 0;
  state.votes = { helpful: 0, notHelpful: 0 };
  setLearnedWeights({});
}
