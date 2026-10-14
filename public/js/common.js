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
})();
