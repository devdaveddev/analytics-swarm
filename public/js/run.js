(() => {
  const { esc, api, go } = window.Bm;
  const id = new URLSearchParams(location.search).get('id');
  const agentsEl = document.getElementById('agents');
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const doneEl = document.getElementById('done-actions');
  const openLink = document.getElementById('open-dashboard');

  if (!id) {
    statusEl.textContent = 'No analysis id was given.';
    return;
  }

  let lastSeq = 0;

  function renderAgents(job) {
    agentsEl.innerHTML = job.pipeline
      .map((p) => {
        const a = job.agents[p.name];
        return `<li class="agent ${esc(a.status)}" data-agent="${esc(p.name)}">
          <span class="dot" aria-hidden="true"></span>
          <div><div class="name">${esc(p.label)}</div><div class="role">${esc(p.role)}</div>
          <div class="summary">${esc(a.summary ?? '')}</div></div>
          <span class="ms">${esc(a.status)}${a.ms !== null ? ` · ${a.ms} ms` : ''}</span>
        </li>`;
      })
      .join('');
  }

  function updateAgent(ev) {
    const row = agentsEl.querySelector(`[data-agent="${ev.agent}"]`);
    if (!row) return;
    row.className = `agent ${ev.status}`;
    row.querySelector('.summary').textContent = ev.message ?? '';
    row.querySelector('.ms').textContent = ev.ms !== undefined ? `${ev.status} · ${ev.ms} ms` : ev.status;
  }

  function log(ev) {
    const time = new Date(ev.at).toLocaleTimeString();
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${esc(time)}</span> ${esc(ev.agent ?? 'control')} · ${esc(ev.message ?? ev.status)}`;
    logEl.appendChild(li);
  }

  // Ignore replayed events after an EventSource reconnect.
  function fresh(ev) {
    if (ev.seq <= lastSeq) return false;
    lastSeq = ev.seq;
    return true;
  }

  async function start() {
    let job;
    try {
      job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      statusEl.textContent = err.message;
      return;
    }
    document.getElementById('company').textContent = `${job.input.companyName} — agent swarm`;
    document.title = `Running: ${job.input.companyName}`;
    renderAgents(job);
    openLink.href = `/dashboard?id=${encodeURIComponent(id)}`;

    const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    es.addEventListener('job', (e) => {
      const ev = JSON.parse(e.data);
      if (!fresh(ev)) return;
      statusEl.textContent = ev.message;
      log(ev);
    });
    es.addEventListener('agent', (e) => {
      const ev = JSON.parse(e.data);
      if (!fresh(ev)) return;
      updateAgent(ev);
      log(ev);
    });
    es.addEventListener('end', async (e) => {
      const ev = JSON.parse(e.data);
      if (!fresh(ev)) return;
      es.close();
      if (ev.status === 'completed') {
        statusEl.textContent = 'Dashboard ready. Opening it in this window…';
        doneEl.hidden = false;
        setTimeout(() => go(openLink.href), 1200);
        return;
      }
      const snapshot = await api(`/api/jobs/${encodeURIComponent(id)}`).catch(() => null);
      statusEl.textContent = 'The analysis stopped before the dashboard was built.';
      errorEl.textContent = snapshot?.error ?? 'Unknown error.';
      errorEl.hidden = false;
    });
    es.onerror = () => {
      statusEl.textContent = 'Connection interrupted. Reconnecting…';
    };
  }

  start();
})();
