// Forecaster: a straight-line revenue trend three months ahead, with a band of one residual standard deviation.
// It is a trend projection, not a seasonal model, and the dashboard labels it that way.
import { linreg, round, stdev } from '../util.js';

export async function forecasterAgent(ctx, steps = 3) {
  const pts = ctx.refiner.series.filter((s) => s.revenue !== null);
  if (pts.length < 3) {
    return { summary: 'Skipped the forecast: it needs at least 3 months of revenue.', points: [] };
  }
  const ys = pts.map((s) => s.revenue);
  const { slope, intercept } = linreg(ys);
  const band = stdev(ys.map((y, i) => y - (intercept + slope * i))) ?? 0;

  const points = pts.map((s) => ({ x: s.month, y: s.revenue, projected: false }));
  for (let k = 1; k <= steps; k++) {
    const y = round(intercept + slope * (pts.length - 1 + k), 0);
    points.push({ x: `+${k} mo`, y, low: round(y - band, 0), high: round(y + band, 0), projected: true });
  }
  const last = points.at(-1);
  return {
    summary: `Projected revenue to ${last.y.toLocaleString('en-US')} in ${steps} months (range ${last.low.toLocaleString('en-US')} to ${last.high.toLocaleString('en-US')}).`,
    points,
  };
}
