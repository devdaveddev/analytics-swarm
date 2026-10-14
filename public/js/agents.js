(() => {
  const { esc, api, store, go } = window.Bm;
  const KEY = 'swarm-workflow';
  const CUSTOM_KEY = 'swarm-custom-agents';
  const GUIDANCE_KEY = 'swarm-guidance';
  const MAX_CUSTOM = 5;
  const lane = document.getElementById('lane');
  const wires = document.getElementById('wires');
  const canvas = document.getElementById('canvas');
  const issuesEl = document.getElementById('issues');
  const paletteEl = document.getElementById('palette');
  const statusEl = document.getElementById('status');
  const saveBtn = document.getElementById('save');
  const saveRunBtn = document.getElementById('save-run');

  const ICON = {
    grip: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></svg>',
    back: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    forward: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    remove: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    add: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  };

  const TEMPLATES = {
    pricing: {
      name: 'Pricing strategist',
      prompt: 'Act as a pricing strategist. Using the KPIs, the feedback about pricing and the recommendations, propose three pricing experiments. For each, give the change, the metric to watch, and the main risk.',
    },
    risk: {
      name: 'Risk reviewer',
      prompt: 'Review the insights, KPIs and forecast for risks. Rank the top three risks by likely impact, explain each in one sentence using the figures, and suggest one mitigation for each.',
    },
    brief: {
      name: 'Executive brief',
      prompt: 'Write a five-sentence brief for a CEO: how the business is doing, the biggest risk, the biggest opportunity, and the one action to take this month. Use plain language and cite the key figures.',
    },
  };

  let meta = null;
  let order = [];
  let drag = null;
  let customs = [];
  // Custom agents behave like optional built-in agents: they read the analysis, so they follow Parser and Refiner.
  const customMeta = (c) => ({
    name: c.id,
    label: c.name,
    role: `Custom agent: ${c.prompt.slice(0, 90)}`,
    requires: ['parser', 'refiner'],
    softAfter: [],
    optional: true,
    custom: true,
  });
  const allAgents = () => [...meta.agents, ...customs.map(customMeta)];
  const agent = (name) => allAgents().find((a) => a.name === name);
  const saveCustoms = () => store.write(CUSTOM_KEY, customs);

  // Same rules as the server (src/workflow.js). The server stays the authority; this gives instant feedback.
  function check(list) {
    const errors = [];
    const warnings = [];
    const pos = new Map(list.map((n, i) => [n, i]));
    for (const a of allAgents()) {
      if (!a.optional && !pos.has(a.name)) errors.push({ agent: a.name, text: `${a.label} is required and cannot be removed.` });
    }
    for (const name of list) {
      const a = agent(name);
      for (const dep of a.requires) {
        if (!pos.has(dep)) errors.push({ agent: name, text: `${a.label} needs ${agent(dep).label}, which is not in the workflow.` });
        else if (pos.get(dep) > pos.get(name)) errors.push({ agent: name, text: `${a.label} must run after ${agent(dep).label}.` });
      }
      for (const dep of a.softAfter) {
        if (pos.has(dep) && pos.get(dep) > pos.get(name)) warnings.push({ agent: name, text: `${a.label} runs before ${agent(dep).label}, so it will not use that output.` });
      }
    }
    if (list.at(-1) !== 'visualizer') errors.push({ agent: 'visualizer', text: 'Visualizer must be the last step.' });
    return { errors, warnings };
  }

  const isVertical = () => getComputedStyle(lane).flexDirection === 'column';

  function nodeHtml(name, i, problems) {
    const a = agent(name);
    const needs = a.requires.map((d) => agent(d).label);
    const state = problems.errors.some((p) => p.agent === name) ? 'has-error' : problems.warnings.some((p) => p.agent === name) ? 'has-warning' : '';
    return `<li class="agent-node ${state}" data-name="${esc(name)}">
      <span class="port in" aria-hidden="true"></span>
      <div class="node-head">
        <button type="button" class="grip" data-grip aria-label="Drag ${esc(a.label)} to reorder">${ICON.grip}</button>
        <span class="step" aria-hidden="true">${i + 1}</span>
        <strong>${esc(a.label)}</strong>
      </div>
      <p class="node-role">${esc(a.role)}</p>
      <p class="node-meta">${needs.length ? `Needs: ${esc(needs.join(', '))}` : 'Needs no earlier agent'}</p>
      <div class="node-foot">
        <span class="tag ${a.custom ? 'tone-accent' : a.optional ? '' : 'tone-good'}">${a.custom ? 'custom' : a.optional ? 'optional' : 'required'}</span>
        <span class="node-actions">
          <button type="button" class="btn-mini" data-move="-1" aria-label="Move ${esc(a.label)} earlier" ${i === 0 ? 'disabled' : ''}>${ICON.back}</button>
          <button type="button" class="btn-mini" data-move="1" aria-label="Move ${esc(a.label)} later" ${i === order.length - 1 ? 'disabled' : ''}>${ICON.forward}</button>
          ${a.custom ? `<button type="button" class="btn-mini" data-edit aria-label="Edit ${esc(a.label)}">${ICON.edit}</button>` : ''}
          ${a.optional ? `<button type="button" class="btn-mini" data-remove aria-label="Remove ${esc(a.label)}">${ICON.remove}</button>` : ''}
        </span>
      </div>
      <span class="port out" aria-hidden="true"></span>
    </li>`;
  }

  function render() {
    const problems = check(order);
    lane.innerHTML = order.map((name, i) => nodeHtml(name, i, problems)).join('');

    const messages = [
      ...problems.errors.map((p) => `<li class="bad">${esc(p.text)}</li>`),
      ...problems.warnings.map((p) => `<li class="warn">${esc(p.text)}</li>`),
    ];
    issuesEl.innerHTML = messages.length ? `<ul>${messages.join('')}</ul>` : '<p class="ok-line">This order is valid.</p>';
    saveBtn.disabled = saveRunBtn.disabled = problems.errors.length > 0;

    const missing = allAgents().filter((a) => !order.includes(a.name));
    paletteEl.innerHTML = missing.length
      ? missing.map((a) => `<div class="palette-row">
          <button type="button" class="palette-item" data-add="${esc(a.name)}">${ICON.add}<span><strong>${esc(a.label)}</strong><small>${esc(a.role)}</small></span></button>
          ${a.custom ? `<button type="button" class="btn-mini" data-delete-custom="${esc(a.name)}" aria-label="Delete ${esc(a.label)} permanently">${ICON.remove}</button>` : ''}
        </div>`).join('')
      : '<p class="muted small">Every agent is already in the workflow.</p>';
    document.getElementById('custom-count').textContent = `${customs.length} of ${MAX_CUSTOM} custom agents created`;

    requestAnimationFrame(drawWires);
  }

  // Wires connect each agent to the next one, and re-measure whenever the layout changes.
  function drawWires() {
    const nodes = [...lane.children];
    const box = canvas.getBoundingClientRect();
    wires.setAttribute('width', canvas.scrollWidth);
    wires.setAttribute('height', canvas.scrollHeight);
    const vertical = isVertical();
    const problems = check(order);
    const bad = new Set(problems.errors.map((p) => p.agent));
    let paths = '';
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = nodes[i].getBoundingClientRect();
      const b = nodes[i + 1].getBoundingClientRect();
      let d;
      if (vertical) {
        const x = a.left - box.left + a.width / 2;
        const y1 = a.bottom - box.top;
        const y2 = b.top - box.top;
        const mid = (y1 + y2) / 2;
        d = `M${x},${y1} C${x},${mid} ${x},${mid} ${x},${y2}`;
      } else {
        const x1 = a.right - box.left;
        const x2 = b.left - box.left;
        const y1 = a.top - box.top + a.height / 2;
        const y2 = b.top - box.top + b.height / 2;
        const mid = (x1 + x2) / 2;
        d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
      }
      const failing = bad.has(order[i]) || bad.has(order[i + 1]);
      paths += `<path d="${d}" class="wire${failing ? ' bad' : ''}" marker-end="url(#arrow${failing ? '-bad' : ''})"/>`;
    }
    wires.innerHTML = `<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker>
      <marker id="arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead bad"/></marker>
    </defs>${paths}`;
  }

  function move(name, toIndex) {
    const next = order.filter((n) => n !== name);
    next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, name);
    if (next.join() === order.join()) return;
    order = next;
    statusEl.textContent = 'Unsaved changes';
    render();
  }

  lane.addEventListener('click', (e) => {
    const li = e.target.closest('.agent-node');
    if (!li) return;
    const name = li.dataset.name;
    const i = order.indexOf(name);
    const button = e.target.closest('[data-move],[data-remove],[data-edit]');
    if (!button) return;
    if ('edit' in button.dataset) return startEdit(name);
    if ('move' in button.dataset) move(name, i + Number(button.dataset.move));
    else if ('remove' in button.dataset) {
      order = order.filter((n) => n !== name);
      statusEl.textContent = 'Unsaved changes';
      render();
    }
    // Keep keyboard focus on the same control after the list re-renders.
    const again = lane.querySelector(`[data-name="${name}"] ${'move' in button.dataset ? `[data-move="${button.dataset.move}"]` : '[data-grip]'}`);
    (again && !again.disabled ? again : lane.querySelector(`[data-name="${name}"] [data-grip]`))?.focus();
  });

  paletteEl.addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-custom]');
    if (del) {
      const id = del.dataset.deleteCustom;
      const c = customs.find((x) => x.id === id);
      if (c && window.confirm(`Delete the custom agent "${c.name}"? This removes its instructions.`)) {
        customs = customs.filter((x) => x.id !== id);
        saveCustoms();
        statusEl.textContent = `Deleted "${c.name}".`;
        render();
      }
      return;
    }
    const item = e.target.closest('[data-add]');
    if (!item) return;
    const name = item.dataset.add;
    const deps = agent(name).requires.map((d) => order.indexOf(d));
    const after = Math.max(-1, ...deps) + 1;
    const visualizerAt = order.indexOf('visualizer');
    const end = visualizerAt === -1 ? order.length : visualizerAt;
    // Custom agents read the analysis, so they go last, where they can also see the Consultant's output.
    const at = agent(name).custom ? end : Math.min(after, end);
    order = [...order.slice(0, at), name, ...order.slice(at)];
    statusEl.textContent = 'Unsaved changes';
    render();
  });

  // Drag and drop: pointer events work for mouse, touch and pen. The node follows the pointer; on release it is
  // inserted before the first node whose centre is past the pointer.
  function dropIndex(pointer) {
    const vertical = isVertical();
    const others = [...lane.children].filter((li) => li !== drag.li);
    let index = 0;
    for (const li of others) {
      const r = li.getBoundingClientRect();
      const centre = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
      if (pointer > centre) index++;
    }
    return { index, others };
  }

  lane.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip) return;
    e.preventDefault();
    const li = grip.closest('.agent-node');
    drag = { li, name: li.dataset.name, x: e.clientX, y: e.clientY, last: { x: e.clientX, y: e.clientY }, index: order.indexOf(li.dataset.name) };
    grip.setPointerCapture(e.pointerId);
    li.classList.add('dragging');
    canvas.classList.add('is-dragging');
    requestAnimationFrame(autoScroll);
  });

  // Moves the dragged node with the pointer and marks where it will land.
  function position() {
    drag.li.style.transform = `translate(${drag.last.x - drag.x}px, ${drag.last.y - drag.y}px)`;
    const { index, others } = dropIndex(isVertical() ? drag.last.y : drag.last.x);
    drag.index = index;
    lane.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    if (others[index]) others[index].classList.add('drop-before');
    else others.at(-1)?.classList.add('drop-after');
  }

  // The lane can be wider than the screen, so scroll while the pointer is held near an edge.
  function autoScroll() {
    if (!drag) return;
    const EDGE = 70;
    const wrap = canvas.parentElement;
    const box = wrap.getBoundingClientRect();
    const speed = (distance) => Math.round(Math.min(1, (EDGE - distance) / EDGE) * 22);
    if (!isVertical()) {
      let dx = 0;
      if (drag.last.x > box.right - EDGE) dx = speed(box.right - drag.last.x);
      else if (drag.last.x < box.left + EDGE) dx = -speed(drag.last.x - box.left);
      if (dx) {
        const before = wrap.scrollLeft;
        wrap.scrollLeft += dx;
        drag.x -= wrap.scrollLeft - before; // keep the node under the pointer
      }
    } else {
      let dy = 0;
      if (drag.last.y > window.innerHeight - EDGE) dy = speed(window.innerHeight - drag.last.y);
      else if (drag.last.y < EDGE) dy = -speed(drag.last.y);
      if (dy) {
        const before = window.scrollY;
        window.scrollBy(0, dy);
        drag.y -= window.scrollY - before;
      }
    }
    position();
    requestAnimationFrame(autoScroll);
  }

  lane.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.last = { x: e.clientX, y: e.clientY };
    position();
  });

  function endDrag(commit) {
    if (!drag) return;
    const { li, name, index } = drag;
    li.style.transform = '';
    li.classList.remove('dragging');
    canvas.classList.remove('is-dragging');
    lane.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    drag = null;
    if (commit) move(name, index);
    else drawWires();
  }
  lane.addEventListener('pointerup', () => endDrag(true));
  lane.addEventListener('pointercancel', () => endDrag(false));

  function save() {
    const ok = store.write(KEY, order);
    statusEl.textContent = ok ? 'Saved. New analyses will use this order.' : 'Could not save: this browser blocks storage.';
    return ok;
  }
  saveBtn.addEventListener('click', save);
  saveRunBtn.addEventListener('click', () => { if (save()) go('/new?sample=1'); });
  document.getElementById('reset').addEventListener('click', () => {
    order = [...meta.defaultOrder];
    store.remove(KEY);
    statusEl.textContent = 'Back to the default order.';
    render();
  });
  window.addEventListener('resize', () => requestAnimationFrame(drawWires));

  // ----- Custom agent form: the agent needs a name and the instructions (prompt) it runs with.
  const form = document.getElementById('custom-form');
  const formError = document.getElementById('custom-error');
  const submitBtn = document.getElementById('custom-submit');
  const cancelBtn = document.getElementById('custom-cancel');
  const promptCount = document.getElementById('prompt-count');
  const guidanceEl = document.getElementById('guidance');
  const guidanceStatus = document.getElementById('guidance-status');

  const newId = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(5));
    return 'custom-' + [...bytes].map((b) => (b % 36).toString(36)).join('');
  };
  const updateCount = () => { promptCount.textContent = `${form.elements.prompt.value.length} / 2000`; };
  form.elements.prompt.addEventListener('input', updateCount);

  function resetForm() {
    form.reset();
    form.elements.id.value = '';
    formError.textContent = '';
    submitBtn.textContent = 'Add to workflow';
    cancelBtn.hidden = true;
    updateCount();
  }

  function startEdit(id) {
    const c = customs.find((x) => x.id === id);
    if (!c) return;
    form.elements.id.value = c.id;
    form.elements.name.value = c.name;
    form.elements.prompt.value = c.prompt;
    submitBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    updateCount();
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.elements.prompt.focus();
  }

  document.querySelectorAll('[data-template]').forEach((button) => {
    button.addEventListener('click', () => {
      const t = TEMPLATES[button.dataset.template];
      form.elements.name.value = t.name;
      form.elements.prompt.value = t.prompt;
      updateCount();
      form.elements.prompt.focus();
    });
  });
  cancelBtn.addEventListener('click', resetForm);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = form.elements.id.value;
    const name = form.elements.name.value.trim();
    const prompt = form.elements.prompt.value.trim();
    if (name.length < 2) { formError.textContent = 'Give the agent a name of at least 2 characters.'; form.elements.name.focus(); return; }
    if (prompt.length < 10) { formError.textContent = 'Write instructions of at least 10 characters so the agent knows what to do.'; form.elements.prompt.focus(); return; }
    if (!id && customs.length >= MAX_CUSTOM) { formError.textContent = `You can create up to ${MAX_CUSTOM} custom agents. Delete one first.`; return; }

    if (id) {
      customs = customs.map((c) => (c.id === id ? { ...c, name, prompt } : c));
      statusEl.textContent = `Updated "${name}".`;
    } else {
      const created = { id: newId(), name, prompt };
      customs = [...customs, created];
      // It reads the analysis, so it runs late: just before the Visualizer, after everything else.
      const visualizerAt = order.indexOf('visualizer');
      const end = visualizerAt === -1 ? order.length : visualizerAt;
      order = [...order.slice(0, end), created.id, ...order.slice(end)];
      statusEl.textContent = `Added "${name}" to the workflow. Save the workflow to use it.`;
    }
    saveCustoms();
    resetForm();
    render();
  });

  // Guidance for the Consultant's written summary. Saved as you type, sent with each analysis.
  guidanceEl.addEventListener('input', () => {
    store.write(GUIDANCE_KEY, guidanceEl.value.slice(0, 1000));
    guidanceStatus.textContent = guidanceEl.value.trim() ? 'Saved in this browser. The Consultant will follow it on the next run.' : '';
  });

  (async function init() {
    try {
      meta = await api('/api/workflow');
    } catch (err) {
      issuesEl.innerHTML = `<p class="bad-line">Could not load the agent list: ${esc(err.message)}</p>`;
      return;
    }
    const savedCustoms = store.read(CUSTOM_KEY, []);
    customs = Array.isArray(savedCustoms) ? savedCustoms.filter((c) => c && /^custom-[a-z0-9]{3,12}$/.test(c.id) && c.name && c.prompt) : [];
    const saved = store.read(KEY, null);
    order = Array.isArray(saved) && saved.every((n) => agent(n)) && check(saved).errors.length === 0 ? saved : [...meta.defaultOrder];
    const guidance = store.read(GUIDANCE_KEY, '');
    guidanceEl.value = typeof guidance === 'string' ? guidance : '';
    render();
  })();
})();
