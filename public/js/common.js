// Shared helpers for every page. Exposed as window.Bm.
(() => {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const fmt = (v, format = 'number', currency = 'USD') => {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    if (format === 'currency') {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v);
    }
    if (format === 'percent') return `${(v * 100).toFixed(1)}%`;
    if (format === 'signed') return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
  };

  const deltaText = (d) => (d === null || d === undefined ? '' : `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${Math.abs(d).toFixed(1)}%`);

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { details: body.details });
    return body;
  }

  // Multi-page navigation happens in the same window.
  const go = (url) => window.location.assign(url);

  window.Bm = { esc, fmt, deltaText, api, go };

  // Theme: dark by default. The choice is remembered per browser; storage errors are ignored.
  const THEME_KEY = 'swarm-theme';
  const readTheme = () => {
    try { return localStorage.getItem(THEME_KEY); } catch { return null; }
  };
  const writeTheme = (value) => {
    try { localStorage.setItem(THEME_KEY, value); } catch { /* private mode: keep the session theme only */ }
  };
  const applyTheme = (value) => {
    document.documentElement.dataset.theme = value;
    const button = document.querySelector('[data-theme-toggle]');
    if (button) {
      const isLight = value === 'light';
      button.setAttribute('aria-pressed', String(isLight));
      button.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
      button.title = isLight ? 'Dark theme' : 'Light theme';
    }
  };
  const ICON_SUN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const ICON_MOON = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function mountThemeToggle() {
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('[data-theme-toggle]')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'theme-toggle';
    button.dataset.themeToggle = '';
    button.innerHTML = ICON_SUN + ICON_MOON;
    button.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      writeTheme(next);
      applyTheme(next);
    });
    bar.appendChild(button);
    applyTheme(document.documentElement.dataset.theme || 'dark');
  }

  applyTheme(readTheme() || 'dark');
  document.addEventListener('DOMContentLoaded', mountThemeToggle);
})();
