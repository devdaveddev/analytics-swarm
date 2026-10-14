(() => {
  const { api, go, esc } = window.Bm;
  const form = document.getElementById('company-form');
  const errorBox = document.getElementById('errors');
  const submitBtn = form.querySelector('button[type="submit"]');

  async function fillSample() {
    try {
      const sample = await api('/api/sample');
      for (const [name, value] of Object.entries(sample)) {
        const el = form.elements[name];
        if (el) el.value = value;
      }
      errorBox.hidden = true;
    } catch (err) {
      showErrors([err.message]);
    }
  }

  function showErrors(messages) {
    errorBox.innerHTML = messages.map((m) => `<div>${esc(m)}</div>`).join('');
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('fill-sample').addEventListener('click', fillSample);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Starting swarm…';
    try {
      const data = Object.fromEntries(new FormData(form));
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
      go(job.links.run);
    } catch (err) {
      showErrors(err.details?.length ? err.details : [err.message]);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Launch agent swarm';
    }
  });

  if (new URLSearchParams(location.search).get('sample') === '1') fillSample();
})();
