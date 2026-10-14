(() => {
  const { esc, fmt, deltaText, api } = window.Bm;
  const LIVE_INTERVAL_MS = 60_000;
  const LABELS = ['positive', 'neutral', 'negative'];
  const params = new URLSearchParams(location.search);
  const root = document.getElementById('app');
  const state = {
    id: params.get('id'),
    spec: null,
    job: null,
    filter: { sentiment: null, aspect: null },
    aspectLabels: {},
    teaches: {},
    live: false,
    timer: null,
    toast: '',
    answer: null,
    asking: false,
  };

  if (!state.id) {
    root.innerHTML = '<p class="empty">No analysis selected. <a href="/new">Start a new one</a>.</p>';
    return;
  }

  const toggle = (current, next) => (current === next ? null : next);
  const busy = () => state.job && (state.job.status === 'queued' || state.job.status === 'running');
  const setStatus = (text) => {
    const el = document.getElementById('live-status');
    if (el) el.textContent = text;
  };

  // One delegated listener survives every re-render.
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-sentiment],[data-aspect],[data-refresh],[data-clear],[data-live],[data-teach],[data-vote-area]');
    if (!el) return;
    const d = el.dataset;
    if ('refresh' in d) return refreshNow();
    if ('live' in d) return setLive(!state.live);
    if ('teach' in d) return teach(Number(d.teach), d.label);
    if ('voteArea' in d) return vote(d.voteArea, d.helpful === 'true');
    if ('clear' in d) state.filter = { sentiment: null, aspect: null };
    else if ('sentiment' in d) state.filter.sentiment = toggle(state.filter.sentiment, d.sentiment);
    else if ('aspect' in d) state.filter.aspect = toggle(state.filter.aspect, d.aspect);
    render();
  });

  root.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-ask]');
    if (!form) return;
    e.preventDefault();
    const question = new FormData(form).get('question')?.toString().trim();
    if (!question || state.asking) return;
    state.asking = true;
    render();
    try {
      state.answer = await api(`/api/jobs/${encodeURIComponent(state.id)}/ask`, { method: 'POST', body: JSON.stringify({ question }) });
    } catch (err) {
      state.answer = { answer: err.message, source: 'rules' };
    }
    state.asking = false;
    render();
    document.getElementById('ask-input')?.focus();
  });

  root.addEventListener('mouseover', (e) => {
    const svg = e.target.closest('svg.graph');
    const node = e.target.closest('[data-node]');
    if (svg && node) focusGraph(svg, node.dataset.node);
  });
  root.addEventListener('mouseout', (e) => {
    const svg = e.target.closest('svg.graph');
    if (svg && !e.relatedTarget?.closest?.('[data-node]')) focusGraph(svg, null);
  });

  async function load({ quiet = false } = {}) {
    const enc = encodeURIComponent(state.id);
    state.job = await api(`/api/jobs/${enc}`);
    if (state.job.status === 'completed') {
      state.spec = await api(`/api/jobs/${enc}/dashboard`);
      state.toast = '';
      render();
      return;
    }
    if (state.job.status === 'failed') {
      if (quiet) {
        state.toast = `Live refresh failed: ${state.job.error}`;
        render();
        return;
      }
      root.innerHTML = `<div class="notice error"><strong>Analysis failed.</strong><div>${esc(state.job.error)}</div></div>
        <p><a class="btn ghost" href="/new">Try again with different data</a></p>`;
      return;
    }
    waitForResult(enc, quiet);
  }

  // While the swarm runs: show progress (or a quiet status line when refreshing a visible dashboard).
  function waitForResult(enc, quiet) {
    if (!quiet || !state.spec) root.innerHTML = `<p class="empty" id="waiting">Analysis in progress…</p>`;
    setStatus('Updating…');
    const es = new EventSource(`/api/jobs/${enc}/events`);
    es.addEventListener('agent', (e) => {
      const ev = JSON.parse(e.data);
      if (ev.status !== 'running') return;
      const waiting = document.getElementById('waiting');
      if (waiting) waiting.textContent = `Analysis in progress — ${ev.message}`;
      setStatus(`Updating — ${ev.message}`);
    });
    es.addEventListener('end', () => {
      es.close();
      load({ quiet }).catch((err) => {
        state.toast = err.message;
        render();
      });
    });
  }

  async function refreshNow() {
    if (busy()) return;
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(state.id)}/refresh`, { method: 'POST' });
      state.id = job.id;
      history.replaceState(null, '', `/dashboard?id=${job.id}`);
      await load({ quiet: state.spec !== null });
    } catch (err) {
      state.toast = `Refresh failed: ${err.message}`;
      render();
    }
  }

  function setLive(on) {
    state.live = on;
    clearInterval(state.timer);
    if (on) state.timer = setInterval(() => { if (!busy()) refreshNow(); }, LIVE_INTERVAL_MS);
    state.toast = on ? `Live on: sources and documents are re-run every ${LIVE_INTERVAL_MS / 1000} seconds.` : 'Live off.';
    render();
  }

  // Feedback loop 1: label corrections teach the sentiment model (applied on the next run).
  async function teach(reviewId, label) {
    const review = state.spec.widgets.find((w) => w.type === 'reviews')?.items.find((r) => r.id === reviewId);
    if (!review) return;
    try {
      const res = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ type: 'review', text: review.text, label }) });
      state.teaches[reviewId] = label;
      state.toast = `Saved. The model adjusted ${res.wordsLearned} word weight(s). Refresh to see the effect on scores.`;
    } catch (err) {
      state.toast = `Could not save label: ${err.message}`;
    }
    render();
  }

  // Feedback loop 2: helpful votes change how strongly an area is prioritised on the next run.
  async function vote(area, helpful) {
    try {
      const res = await api('/api/feedback', { method: 'POST', body: JSON.stringify({ type: 'recommendation', area, helpful }) });
      state.toast = `Priority for "${area}" is now ×${res.multiplier}. It applies to the next run.`;
    } catch (err) {
      state.toast = `Could not save vote: ${err.message}`;
    }
    render();
  }

  function kpiHtml(t, cur) {
    const delta = t.delta !== null && t.delta !== undefined
      ? `<span class="kpi-delta">${esc(deltaText(t.delta))} ${esc(t.deltaLabel ?? '')}</span>`
      : '';
    return `<article class="kpi tone-${esc(t.tone)}">
      <span class="kpi-label">${esc(t.label)}</span>
      <strong class="kpi-value">${esc(fmt(t.value, t.format, cur))}</strong>${delta}
    </article>`;
  }

  function lineChart(w, cur) {
    const pts = (w.series[0]?.points ?? []).filter((p) => p.y !== null);
    if (pts.length < 2) return empty('Need at least two months of revenue to draw a trend.');
    const W = 720, H = 260, P = 44;
    const ys = pts.map((p) => p.y);
    const min = Math.min(...ys), max = Math.max(...ys), span = max - min || 1;
    const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    const grid = [min, (min + max) / 2, max]
      .map((v) => `<line class="grid-line" x1="${P}" x2="${W - P}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>
        <text class="axis" x="2" y="${(y(v) + 4).toFixed(1)}">${esc(fmt(v, w.format, cur))}</text>`)
      .join('');
    const step = Math.ceil(pts.length / 8);
    const labels = pts
      .map((p, i) => (i % step === 0 || i === pts.length - 1
        ? `<text class="axis" text-anchor="middle" x="${x(i).toFixed(1)}" y="${H - 14}">${esc(p.x)}</text>`
        : ''))
      .join('');
    const dots = pts
      .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="4"><title>${esc(p.x)}: ${esc(fmt(p.y, w.format, cur))}</title></circle>`)
      .join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.title)}">${grid}<path class="line" d="${path}"/>${dots}${labels}</svg>`;
  }

  // Four-column graph: feature areas -> KPIs -> insights -> actions. Hover a node to trace its links.
  function graph(w) {
    const W = 900, BW = 190, BH = 44, TOP = 30;
    const perColumn = [0, 1, 2, 3].map((c) => w.nodes.filter((n) => Math.round(n.x * 3) === c).length);
    const H = Math.max(260, Math.max(...perColumn, 1) * 62 + TOP);
    const pos = {};
    for (const n of w.nodes) {
      const left = 10 + n.x * (W - BW - 20);
      const cy = TOP + n.y * (H - TOP - 12);
      pos[n.id] = { left, right: left + BW, cy, top: cy - BH / 2 };
    }
    const headings = w.columns
      .map((c, i) => `<text class="col-title" x="${(10 + (i / 3) * (W - BW - 20) + BW / 2).toFixed(1)}" y="16" text-anchor="middle">${esc(c)}</text>`)
      .join('');
    const edges = w.edges
      .filter((e) => pos[e.from] && pos[e.to])
      .map((e) => {
        const a = pos[e.from], b = pos[e.to];
        const mid = (a.right + b.left) / 2;
        return `<path class="edge kind-${esc(e.kind)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"
          d="M${a.right.toFixed(1)},${a.cy.toFixed(1)} C${mid.toFixed(1)},${a.cy.toFixed(1)} ${mid.toFixed(1)},${b.cy.toFixed(1)} ${b.left.toFixed(1)},${b.cy.toFixed(1)}"/>`;
      })
      .join('');
    const nodes = w.nodes
      .map((n) => {
        const p = pos[n.id];
        const label = n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label;
        return `<g class="node group-${esc(n.group)} tone-${esc(n.tone)}" data-node="${esc(n.id)}" tabindex="0">
          <title>${esc(n.label)}${n.detail ? ` — ${esc(n.detail)}` : ''}</title>
          <rect x="${p.left.toFixed(1)}" y="${p.top.toFixed(1)}" width="${BW}" height="${BH}" rx="10"/>
          <text x="${(p.left + 12).toFixed(1)}" y="${(p.cy + 4).toFixed(1)}">${esc(label)}</text></g>`;
      })
      .join('');
    const legend = `<div class="graph-legend"><span><i class="lg kind-addresses"></i>addresses</span><span><i class="lg kind-signals"></i>signals</span><span><i class="lg kind-drives"></i>drives</span></div>`;
    return `${legend}<div class="graph-scroll"><svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.title)}">
      ${headings}${edges}${nodes}</svg></div>
      <p class="muted small">Hover a node to see what it connects to. Feature areas feed the actions that address them.</p>`;
  }

  function focusGraph(svg, id) {
    svg.querySelectorAll('.on').forEach((el) => el.classList.remove('on'));
    svg.classList.toggle('focus', Boolean(id));
    if (!id) return;
    const linked = new Set([id]);
    svg.querySelectorAll('.edge').forEach((edge) => {
      const { from, to } = edge.dataset;
      if (from === id || to === id) {
        edge.classList.add('on');
        linked.add(from);
        linked.add(to);
      }
    });
    svg.querySelectorAll('.node').forEach((g) => {
      if (linked.has(g.dataset.node)) g.classList.add('on');
    });
  }

  function funnel(w, cur) {
    const max = Math.max(...w.stages.map((s) => s.value ?? 0), 1);
    const rows = w.stages
      .map((s) => `<li>
          <div class="funnel-row"><span>${esc(s.label)}</span><strong>${esc(fmt(s.value, 'number', cur))}</strong></div>
          <div class="funnel-bar"><span style="width:${(((s.value ?? 0) / max) * 100).toFixed(1)}%"></span></div>
          ${s.rate !== null && s.rate !== undefined ? `<small class="muted">${esc(fmt(s.rate, 'percent'))} of previous stage</small>` : ''}
        </li>`)
      .join('');
    return `<ol class="funnel">${rows}</ol>${w.footnote ? `<p class="muted small">${esc(w.footnote)}</p>` : ''}`;
  }

  function donut(w) {
    const total = w.slices.reduce((a, s) => a + s.value, 0);
    if (!total) return empty('No reviews to chart.');
    const R = 54, C = 2 * Math.PI * R;
    let offset = 0;
    const arcs = w.slices
      .filter((s) => s.value > 0)
      .map((s) => {
        const len = (s.value / total) * C;
        const dim = state.filter.sentiment && state.filter.sentiment !== s.key ? ' dim' : '';
        const arc = `<circle class="arc tone-${s.tone}${dim}" r="${R}" cx="80" cy="80"
          stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"
          data-sentiment="${s.key}"><title>${esc(s.label)}: ${s.value}</title></circle>`;
        offset += len;
        return arc;
      })
      .join('');
    const legend = w.slices
      .map((s) => {
        const active = state.filter.sentiment === s.key;
        const dim = state.filter.sentiment && !active ? ' dim' : '';
        return `<button class="legend-item${dim}" data-sentiment="${s.key}" aria-pressed="${active}">
          <span><span class="swatch tone-${s.tone}"></span>${esc(s.label)}</span>
          <span>${s.value} · ${Math.round((s.value / total) * 100)}%</span>
        </button>`;
      })
      .join('');
    return `<div class="donut-wrap">
      <svg class="donut" viewBox="0 0 160 160" role="img" aria-label="Sentiment split"><g transform="rotate(-90 80 80)">${arcs}</g></svg>
      <div class="legend">${legend}</div>
    </div>`;
  }

  function bars(w) {
    if (!w.bars.length) return empty('No review mentions by feature area.');
    return w.bars
      .map((b) => {
        const magnitude = Math.min(Math.abs(b.value ?? 0), 1) * 50;
        const left = (b.value ?? 0) >= 0 ? 50 : 50 - magnitude;
        const active = state.filter.aspect === b.key;
        const dim = state.filter.aspect && !active ? ' dim' : '';
        return `<button class="bar-row${dim}" data-aspect="${b.key}" aria-pressed="${active}">
          <span>${esc(b.label)} <small class="muted">(${b.mentions})</small></span>
          <span class="diverge"><span class="bar tone-${b.tone}" style="left:${left.toFixed(1)}%;width:${magnitude.toFixed(1)}%"></span></span>
          <span class="bar-value">${esc(fmt(b.value, 'signed'))}</span>
        </button>`;
      })
      .join('');
  }

  function insights(w) {
    if (!w.items.length) return empty('No insights were generated.');
    return `<ul class="insights">${w.items
      .map((i) => `<li class="insight sev-${esc(i.severity)}"><span class="chip">${esc(i.severity)}</span>
        <div><strong>${esc(i.title)}</strong><p>${esc(i.detail)}</p></div></li>`)
      .join('')}</ul>`;
  }

  function table(w) {
    if (!w.rows.length) return empty('Nothing to show for this table.');
    const voting = Array.isArray(w.voteAreas);
    const head = [...w.columns.map((c) => `<th scope="col">${esc(c)}</th>`), voting ? '<th scope="col">Helpful?</th>' : ''].join('');
    const body = w.rows
      .map((r, i) => {
        const cells = r.map((c) => `<td>${esc(c)}</td>`).join('');
        const vote = voting
          ? `<td class="vote">
              <button class="btn-mini" data-vote-area="${esc(w.voteAreas[i])}" data-helpful="true" aria-label="Mark as helpful: ${esc(w.voteAreas[i])}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10v11M7 10l4-7a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-1.5 7.5A2 2 0 0 1 17.5 20H7"/></svg></button>
              <button class="btn-mini" data-vote-area="${esc(w.voteAreas[i])}" data-helpful="false" aria-label="Mark as not helpful: ${esc(w.voteAreas[i])}"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 14V3M17 14l-4 7a2 2 0 0 1-2-2v-4H5a2 2 0 0 1-2-2l1.5-7.5A2 2 0 0 1 6.5 4H17"/></svg></button>
            </td>`
          : '';
        return `<tr>${cells}${vote}</tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function documents(w) {
    if (!w.items.length) return empty('No documents were pasted. Add some on the form to analyse them here.');
    return w.items
      .map((d) => {
        const tone = d.sentiment.label === 'positive' ? 'good' : d.sentiment.label === 'negative' ? 'bad' : 'neutral';
        return `<article class="doc">
          <header><strong>${esc(d.title)}</strong>
            <span class="tag tone-${tone}">${esc(d.sentiment.label)} ${esc(fmt(d.sentiment.score, 'signed'))}</span>
            <small class="muted">${esc(d.words)} words</small></header>
          ${d.flagged ? '<p class="notice">Contains instruction-like text; kept out of AI prompts.</p>' : ''}
          <h3>Summary</h3>${d.summary.map((s) => `<p>${esc(s)}</p>`).join('') || '<p class="muted">Too short to summarise.</p>'}
          ${d.facts.length ? `<h3>Facts &amp; figures</h3><ul>${d.facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          <div class="chips">${d.topTerms.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        </article>`;
      })
      .join('');
  }

  function reviews(w) {
    const f = state.filter;
    const labelOf = (r) => state.teaches[r.id] ?? r.label;
    const items = w.items.filter(
      (r) => (!f.sentiment || labelOf(r) === f.sentiment) && (!f.aspect || r.aspects.includes(f.aspect)),
    );
    const activeParts = [f.sentiment, f.aspect ? state.aspectLabels[f.aspect] ?? f.aspect : null].filter(Boolean);
    const controls = activeParts.length
      ? `<button class="btn-chip" data-clear>Clear filters (${esc(activeParts.join(', '))})</button>`
      : '<span class="muted small">Click a sentiment slice or a feature bar to filter reviews.</span>';
    const shown = items.slice(0, 60);
    const list = shown.length
      ? `<ul class="reviews">${shown
          .map((r) => {
            const current = labelOf(r);
            const tone = current === 'positive' ? 'good' : current === 'negative' ? 'bad' : 'neutral';
            const teach = LABELS.map((l) =>
              `<button class="btn-mini${l === current ? ' on' : ''}" data-teach="${r.id}" data-label="${l}" aria-pressed="${l === current}">${l}</button>`,
            ).join('');
            return `<li class="review tone-${tone}">
              <div class="meta">
                <span>${r.rating ? '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating) : 'no rating'}</span>
                <span>${esc(current)}</span>
                ${r.flagged ? '<span class="tag">flagged: instruction-like text</span>' : ''}
                ${r.aspects.map((a) => `<span class="tag">${esc(w.aspectLabels[a] ?? a)}</span>`).join('')}
              </div>
              <p>${esc(r.text)}</p>
              <div class="teach"><span class="muted small">Correct the label:</span> ${teach}</div>
            </li>`;
          })
          .join('')}</ul>`
      : empty('No reviews match this filter.');
    return `<div class="chips">${controls}</div>${list}
      <p class="muted small">Showing ${shown.length} of ${items.length} matching review(s).</p>`;
  }

  function summary(w) {
    return w.body
      .split(/\n+/)
      .filter(Boolean)
      .map((p) => `<p>${esc(p)}</p>`)
      .join('');
  }

  function trace() {
    const job = state.job;
    if (!job) return '';
    const rows = job.pipeline.map((p) => {
      const a = job.agents[p.name];
      const color = a.status === 'done' ? 'var(--success)' : a.status === 'failed' ? 'var(--danger)' : 'var(--neutral)';
      return `<li><span class="dot" style="background:${color}"></span>
        <div><strong>${esc(p.label)}</strong><div class="summary">${esc(a.summary ?? a.status)}</div></div>
        <span class="ms">${a.ms !== null ? `${a.ms} ms` : ''}</span></li>`;
    });
    return `<ol>${rows.join('')}</ol>`;
  }

  function widgetHtml(w, cur) {
    const renderers = {
      line: () => lineChart(w, cur),
      forecast: () => forecastChart(w, cur),
      graph: () => graph(w),
      funnel: () => funnel(w, cur),
      donut: () => donut(w),
      bars: () => bars(w),
      insights: () => insights(w),
      table: () => table(w),
      documents: () => documents(w),
      reviews: () => reviews(w),
      text: () => summary(w),
    };
    const body = (renderers[w.type] ?? (() => empty('Unsupported widget.')))();
    return `<section class="card widget size-${esc(w.size)}" id="w-${esc(w.id)}">
      <h2>${esc(w.title)}</h2>${body}</section>`;
  }

  function forecastChart(w, cur) {
    const pts = w.points ?? [];
    if (pts.length < 3) return empty('Need at least three months of revenue to project a trend.');
    const W = 720, H = 240, P = 44;
    const vals = pts.flatMap((p) => [p.y, p.low ?? p.y, p.high ?? p.y]);
    const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
    const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
    const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
    const actual = pts.filter((p) => !p.projected);
    const firstProjected = pts.findIndex((p) => p.projected) - 1;
    const path = (list, offset = 0) => list.map((p, i) => `${i ? 'L' : 'M'}${x(i + offset).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    const projected = pts.slice(firstProjected);
    const band = [
      ...projected.map((p, i) => `${i ? 'L' : 'M'}${x(firstProjected + i).toFixed(1)},${y(p.high).toFixed(1)}`),
      ...projected.slice().reverse().map((p, i) => `L${x(pts.length - 1 - i).toFixed(1)},${y(p.low).toFixed(1)}`),
    ].join(' ') + ' Z';
    const dots = pts.map((p, i) => `<circle class="${p.projected ? 'proj' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="4"><title>${esc(p.x)}: ${esc(fmt(p.y, 'currency', cur))}${p.projected ? ` (range ${esc(fmt(p.low, 'currency', cur))} – ${esc(fmt(p.high, 'currency', cur))})` : ''}</title></circle>`).join('');
    const labels = pts.map((p, i) => `<text class="axis" text-anchor="middle" x="${x(i).toFixed(1)}" y="${H - 14}">${esc(p.x)}</text>`).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(w.title)}">
      <path class="band" d="${band}"/>
      <path class="line" d="${path(actual)}"/>
      <path class="line proj-line" d="M${x(firstProjected).toFixed(1)},${y(pts[firstProjected].y).toFixed(1)} ${projected.slice(1).map((p, i) => `L${x(firstProjected + 1 + i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ')}"/>
      ${dots}${labels}</svg>
      <p class="muted small">${esc(w.note)}</p>`;
  }

  function healthBanner(s) {
    const h = s.health ?? { status: 'healthy', label: 'No critical issues' };
    const text = { attention: 'Needs attention', watch: 'Watch closely', healthy: 'Healthy' }[h.status] ?? 'Status';
    return `<section class="health health-${esc(h.status)}" aria-label="Overall status">
      <span class="health-dot" aria-hidden="true"></span>
      <div><strong>${esc(text)}</strong> <span class="muted">${esc(h.label)}</span></div>
    </section>`;
  }

  function askPanel() {
    const a = state.answer;
    return `<section class="card ask" aria-labelledby="ask-title">
      <h2 id="ask-title">Ask your data</h2>
      <form data-ask class="ask-form">
        <label class="visually-hidden" for="ask-input">Question about this dashboard</label>
        <input id="ask-input" name="question" type="text" maxlength="500" placeholder="e.g. Why is churn high? What should we fix first?" autocomplete="off" required>
        <button class="btn" type="submit" ${state.asking ? 'disabled' : ''}>${state.asking ? 'Thinking…' : 'Ask'}</button>
      </form>
      <p class="muted small">Answers use only this dashboard's figures. Try “What is the top risk?” or “Which KPI changed most?”</p>
      ${a ? `<div class="answer" role="status"><p>${esc(a.answer)}</p><p class="muted small">Source: ${a.source === 'ollama' ? 'local model' : 'rule-based'}</p></div>` : ''}
    </section>`;
  }

  function empty(text) {
    return `<p class="empty">${esc(text)}</p>`;
  }

  // Sections turn one long column into a scannable page: overview first, details on demand.
  const SECTIONS = [
    { id: 'trends', title: 'Trends & funnel', widgets: ['forecast', 'funnel', 'sentiment'] },
    { id: 'findings', title: 'Findings & actions', widgets: ['insights', 'aspects', 'graph', 'recommendations'] },
    { id: 'customers', title: 'Customer voice', widgets: ['reviews', 'documents'] },
    { id: 'data', title: 'Sources & summary', widgets: ['sources', 'summary'] },
  ];
  const SIZE = { sources: 'half', summary: 'wide', graph: 'wide', recommendations: 'wide' };
  const isEmpty = (w) => (w.type === 'documents' && !w.items.length) || (w.id === 'sources' && !w.rows.length);

  function layout(s) {
    const byId = Object.fromEntries(s.widgets.map((w) => [w.id, w]));
    const hasForecast = (byId.forecast?.points?.length ?? 0) >= 3;
    const used = new Set(hasForecast ? ['revenue-trend'] : []);
    const sections = SECTIONS.map((sec) => {
      const ids = sec.id === 'trends' && !hasForecast ? ['revenue-trend', ...sec.widgets] : sec.widgets;
      ids.forEach((id) => used.add(id));
      return { ...sec, items: ids.map((id) => byId[id]).filter((w) => w && !isEmpty(w)) };
    });
    const rest = s.widgets.filter((w) => !used.has(w.id) && !isEmpty(w));
    if (rest.length) sections.push({ id: 'more', title: 'More', items: rest });
    return sections.filter((sec) => sec.items.length);
  }

  function sectionsHtml(sections, cur) {
    return sections
      .map((sec) => `<section class="dash-section" id="sec-${sec.id}" aria-labelledby="h-${sec.id}">
        <h2 class="sec-title" id="h-${sec.id}">${esc(sec.title)}</h2>
        <div class="grid">${sec.items.map((w) => widgetHtml({ ...w, size: SIZE[w.id] ?? w.size }, cur)).join('')}</div>
      </section>`)
      .join('');
  }

  function sectionNav(sections) {
    const links = [{ id: 'overview', title: 'Overview' }, ...sections].map((s) => `<a href="#sec-${s.id}">${esc(s.title)}</a>`);
    return `<nav class="sec-nav" aria-label="Dashboard sections">${links.join('')}</nav>`;
  }

  function render() {
    const s = state.spec;
    const cur = s.currency;
    const sections = layout(s);
    state.aspectLabels = s.widgets.find((w) => w.type === 'reviews')?.aspectLabels ?? {};
    document.title = s.title;
    const generated = new Date(s.generatedAt).toLocaleString();
    const warnings = s.warnings.length
      ? `<div class="notice"><strong>Data notes</strong>${s.warnings.map((w) => `<div>${esc(w)}</div>`).join('')}</div>`
      : '';
    const toast = state.toast ? `<div class="notice toast" role="status">${esc(state.toast)}</div>` : '';

    root.innerHTML = `
      <div class="dash-head">
        <div>
          <h1>${esc(s.title)}</h1>
          <p class="muted">Generated ${esc(generated)} · data confidence ${Math.round(s.confidence * 100)}%</p>
          <p class="muted small" id="live-status" aria-live="polite"></p>
        </div>
        <div class="head-actions">
          <button class="btn ghost${state.live ? ' on' : ''}" data-live aria-pressed="${state.live}">${state.live ? 'Live: on' : 'Live: off'}</button>
          <button class="btn ghost" data-refresh>Refresh</button>
          <a class="btn" href="/new">New analysis</a>
        </div>
      </div>
      ${toast}
      ${warnings}
      ${sectionNav(sections)}
      <section class="overview" id="sec-overview">
      ${healthBanner(s)}
      <section class="kpis">${s.kpiTiles.map((t) => kpiHtml(t, cur)).join('')}</section>
      ${askPanel()}
      </section>
      ${sectionsHtml(sections, cur)}
      <details class="card timeline"><summary>Agent swarm trace (${s.meta.stages.length} stages)</summary>${trace()}</details>
    `;
  }

  load().catch((err) => {
    root.innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  });
})();
