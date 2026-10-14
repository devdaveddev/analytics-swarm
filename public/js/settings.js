(() => {
  const { api, store } = window.Bm;
  const KEY = 'swarm-llm';
  const form = document.getElementById('llm-form');
  const result = document.getElementById('result');
  const note = document.getElementById('server-note');
  let providers = {};

  const current = () => {
    const data = Object.fromEntries(new FormData(form));
    return { provider: data.provider, model: data.model.trim(), baseUrl: data.baseUrl.trim(), apiKey: data.apiKey.trim() };
  };

  function show(message, ok) {
    result.className = `result ${ok === undefined ? '' : ok ? 'ok' : 'bad'}`;
    result.textContent = message;
  }

  // Show only the fields the chosen provider needs, and suggest its default model.
  function syncFields({ keepModel = false } = {}) {
    const provider = form.elements.provider.value;
    form.querySelectorAll('[data-for]').forEach((el) => {
      el.hidden = !el.dataset.for.split(' ').includes(provider);
    });
    const info = providers[provider];
    form.elements.model.placeholder = info?.defaultModel ?? '';
    form.elements.baseUrl.placeholder = info?.defaultBaseUrl ?? '';
    if (!keepModel && !form.elements.model.value) form.elements.model.value = '';
  }

  function fill(settings) {
    form.elements.provider.value = settings.provider;
    form.elements.model.value = settings.model ?? '';
    form.elements.baseUrl.value = settings.baseUrl ?? '';
    form.elements.apiKey.value = settings.apiKey ?? '';
    syncFields({ keepModel: true });
  }

  form.addEventListener('change', (e) => {
    if (e.target.name === 'provider') {
      form.elements.model.value = '';
      syncFields();
      show('');
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const settings = current();
    if (settings.provider !== 'ollama' && !settings.apiKey) {
      show('Add an API key, or switch back to Ollama.', false);
      return;
    }
    const saved = store.write(KEY, settings);
    show(saved ? 'Saved. New analyses will use these settings.' : 'Could not save: this browser blocks storage. The settings apply to this page only.', saved);
  });

  document.getElementById('reset').addEventListener('click', () => {
    store.remove(KEY);
    fill({ provider: 'ollama', model: '', baseUrl: '', apiKey: '' });
    show('Back to the Ollama default.', true);
  });

  document.getElementById('test').addEventListener('click', async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    show('Testing…');
    try {
      const res = await api('/api/llm/test', { method: 'POST', body: JSON.stringify({ llm: current() }) });
      show(res.ok ? `Connected. The model replied: “${res.reply}”` : `Not connected: ${res.error}`, res.ok);
    } catch (err) {
      show(`Test failed: ${err.details?.join(' ') ?? err.message}`, false);
    }
    button.disabled = false;
  });

  (async function init() {
    try {
      const info = await api('/api/llm/providers');
      providers = info.providers;
      if (!info.ollamaEnabled) {
        note.hidden = false;
        note.innerHTML = `Ollama is turned off on this server, so the default provider gives rule-based answers only. Add a key below to get written summaries here.`;
      }
    } catch { /* the form still works without provider hints */ }
    fill(store.read(KEY, { provider: 'ollama', model: '', baseUrl: '', apiKey: '' }));
  })();
})();
