(() => {
  const { api, go, esc, store } = window.Bm;
  const WORKFLOW_KEY = 'swarm-workflow';
  const LLM_KEY = 'swarm-llm';
  const configEl = document.getElementById('run-config');

  // The workflow and model chosen on the Agents and API Key pages travel with each analysis.
  const savedWorkflow = () => {
    const w = store.read(WORKFLOW_KEY, null);
    return Array.isArray(w) && w.length ? w : null;
  };
  const savedLLM = () => store.read(LLM_KEY, { provider: 'ollama' });

  function showConfig() {
    const workflow = savedWorkflow();
    const llm = savedLLM();
    const names = { ollama: 'Ollama', openai: 'OpenAI-compatible', anthropic: 'Anthropic' };
    configEl.innerHTML = `Workflow: <strong>${workflow ? workflow.length : 8} agents</strong>${workflow ? '' : ' (default order)'} · <a href="/agents">edit</a> &nbsp; Model: <strong>${esc(names[llm.provider] ?? 'Ollama')}</strong> · <a href="/settings">change</a>`;
  }
  showConfig();
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
      const workflow = savedWorkflow();
      if (workflow) data.workflow = workflow;
      data.llm = savedLLM();
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
      go(job.links.run);
    } catch (err) {
      showErrors(err.details?.length ? err.details : [err.message]);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Launch agent swarm';
    }
  });

  // The Analysis Demo page always opens with the test data loaded.
  if (!form.elements.companyName.value) fillSample();
})();
