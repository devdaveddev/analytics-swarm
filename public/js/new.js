(() => {
  const { api, go, esc, store } = window.Bm;
  const WORKFLOW_KEY = 'swarm-workflow';
  const LLM_KEY = 'swarm-llm';
  const configEl = document.getElementById('run-config');

  // The workflow and model chosen on the Agents and API Key pages travel with each analysis.
  const savedCustoms = () => {
    const c = store.read('swarm-custom-agents', []);
    return Array.isArray(c) ? c.filter((x) => x && x.id && x.name && x.prompt) : [];
  };
  // A saved order may mention a custom agent that was deleted since; drop those so the run is not rejected.
  const savedWorkflow = () => {
    const w = store.read(WORKFLOW_KEY, null);
    if (!Array.isArray(w) || !w.length) return null;
    const known = new Set(savedCustoms().map((c) => c.id));
    return w.filter((name) => !name.startsWith('custom-') || known.has(name));
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
      if (workflow) {
        data.workflow = workflow;
        data.customAgents = savedCustoms().filter((c) => workflow.includes(c.id));
      }
      const guidance = store.read('swarm-guidance', '');
      if (typeof guidance === 'string' && guidance.trim()) data.guidance = guidance;
      data.llm = savedLLM();
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
      go(job.links.run);
    } catch (err) {
      showErrors(err.details?.length ? err.details : [err.message]);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Launch agent swarm';
    }
  });

  // ----- File upload: spreadsheets and documents fill the form instead of typing.
  const MAX_FILE = 4 * 1024 * 1024;
  const fileList = document.getElementById('file-list');
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  // The first uploaded reviews or documents replace the sample text. Later ones are added to it.
  const uploaded = { reviews: false, documents: false };
  const SAMPLE_NAME = 'Northwind Analytics';

  const toBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });

  const addLine = (kind, text, state = 'ok') => {
    const li = document.createElement('li');
    li.className = `file-${state}`;
    li.innerHTML = `<span class="tag ${state === 'ok' ? 'tone-good' : state === 'warn' ? '' : 'tone-bad'}">${kind}</span> ${text}`;
    fileList.appendChild(li);
  };

  function applyItem(item) {
    if (item.kind === 'metrics') {
      form.elements.metrics.value = item.csv;
      addLine('Metrics', `${esc(item.source)}: ${item.rows} month(s), columns ${esc(item.columns.join(', '))}${item.note ? ` (${esc(item.note)})` : ''}`);
    } else if (item.kind === 'reviews') {
      const field = form.elements.reviews;
      field.value = uploaded.reviews && field.value.trim() ? `${field.value.trimEnd()}\n${item.lines.join('\n')}` : item.lines.join('\n');
      uploaded.reviews = true;
      addLine('Reviews', `${esc(item.source)}: ${item.count} review(s)${item.note ? ` (${esc(item.note)})` : ''}`);
    } else {
      const field = form.elements.documents;
      const block = `# ${item.title}\n${item.text}`;
      field.value = uploaded.documents && field.value.trim() ? `${field.value.trimEnd()}\n---\n${block}` : block;
      uploaded.documents = true;
      addLine('Document', `${esc(item.source)}: "${esc(item.title)}", ${item.words} words${item.note ? ` (${esc(item.note)})` : ''}`);
    }
  }

  async function handleFiles(files) {
    errorBox.hidden = true;
    for (const file of files) {
      if (file.size > MAX_FILE) { addLine('Too big', `${esc(file.name)} is larger than 4 MB.`, 'bad'); continue; }
      try {
        const result = await api('/api/parse-file', { method: 'POST', body: JSON.stringify({ name: file.name, data: await toBase64(file) }) });
        result.items.forEach(applyItem);
        result.skipped.forEach((s) => addLine('Skipped', `${esc(s.source)}: ${esc(s.reason)}`, 'warn'));
      } catch (err) {
        addLine('Failed', `${esc(file.name)}: ${esc(err.message)}`, 'bad');
      }
    }
    if (form.elements.companyName.value === SAMPLE_NAME && fileList.querySelector('.file-ok')) {
      addLine('Next', 'The company details below are still the sample. Update them, or use Clear all fields first.', 'warn');
    }
  }

  fileInput.addEventListener('change', () => { handleFiles([...fileInput.files]); fileInput.value = ''; });
  ['dragenter', 'dragover'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => dropzone.addEventListener(t, (e) => { e.preventDefault(); dropzone.classList.remove('over'); }));
  dropzone.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));

  document.getElementById('clear-fields').addEventListener('click', () => {
    form.querySelectorAll('input[type=text], input:not([type]), input[type=number], textarea').forEach((el) => { if (el.name && el.name !== 'currency') el.value = ''; });
    form.elements.industry.value = 'general';
    uploaded.reviews = uploaded.documents = false;
    fileList.innerHTML = '';
    errorBox.hidden = true;
  });

  // The Analysis Demo page always opens with the test data loaded.
  if (!form.elements.companyName.value) fillSample();
})();
