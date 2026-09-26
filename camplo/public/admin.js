/* Camplo Super Admin console (ADL D-33: separate auth route, email + password + TOTP; D-23).
   Aggregate data only — the Super Admin never sees lead or deployment content (ADL §7 #5). */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var overlay = document.getElementById('overlay');
  var ic = window.CamploIcons.ic;
  var TOKEN_KEY = 'camplo-admin-token';
  var S = { token: read(), accounts: null, health: null, filter: 'all', q: '', detail: null, error: null };

  function read() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function save(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (S.token) headers.Authorization = 'Bearer ' + S.token;
    return fetch('/api' + path, { method: opts.method || 'GET', headers: headers, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (r.status === 401 && path !== '/admin/api/login') { S.token = null; save(null); render(); throw new Error('Session expired. Sign in again.'); }
        if (!r.ok) throw new Error((j && j.message) || 'Request failed (' + r.status + ').');
        return j;
      });
    });
  }

  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 220); }, 3000);
  }

  // ---------------------------------------------------------------- views
  function loginView() {
    return '<div class="auth"><div class="auth-card"><div class="auth-logo">C<span>.</span></div>' +
      '<div style="text-align:center"><div class="h2">Super Admin</div><div class="small">Email, password and your authenticator code.</div></div>' +
      '<form class="col gap16" id="loginForm">' +
      '<div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="username" required value="' + esc(S.email || '') + '" /></div>' +
      '<div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" required /></div>' +
      '<div class="field"><label>6-digit code</label><input class="input mono" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>' +
      (S.error ? '<span class="errmsg">' + esc(S.error) + '</span>' : '') +
      '<button class="btn btn-primary btn-full" type="submit">Sign in</button></form>' +
      '<a class="small" href="/" style="text-align:center">← Back to Camplo</a></div></div>';
  }

  var STATUS = { active: 'b-green', pending_activation: 'b-amber', suspended: 'b-red', flagged: 'b-purple' };
  function badge(st) { return '<span class="badge ' + (STATUS[st] || 'b-grey') + '">' + esc(st.replace('_', ' ')) + '</span>'; }

  function consoleView() {
    var h = S.health, list = S.accounts;
    var tiles = h ? [
      ['Leads ingested today', h.leadsIngestedToday],
      ['Ingestion error rate (24h)', (h.ingestionErrorRate24h * 100).toFixed(1) + '%'],
      ['Active webhook sources', h.activeWebhookSources],
      ['Queue depth', h.queueDepth + (h.queueWarning ? ' ⚠' : '')],
    ] : [];
    var rows = (list || []).filter(function (a) {
      return (S.filter === 'all' || a.status === S.filter) && (!S.q || (a.businessName + ' ' + a.ownerEmail).toLowerCase().indexOf(S.q) >= 0);
    });
    var counts = {}; (list || []).forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1; });
    return '<div class="adm-wrap">' +
      '<div class="adm-head"><div class="row gap12"><div class="logo">C<span>.</span></div><div><div class="h1" style="font-size:24px">Super Admin</div><div class="small">Accounts, activation and platform health. Aggregates only.</div></div></div>' +
      '<div class="row"><button class="btn btn-ghost btn-sm" data-act="refresh">' + ic('refresh', 14) + ' Refresh</button><button class="btn btn-ghost btn-sm" data-act="logout">Sign out</button></div></div>' +
      '<div class="adm-tiles">' + (h ? tiles.map(function (t) { return '<div class="card"><div class="label">' + t[0] + '</div><b>' + esc(t[1]) + '</b></div>'; }).join('') : '<div class="small">Loading health…</div>') + '</div>' +
      (h && h.staleSources.length ? '<div class="banner amber" style="margin-bottom:24px">' + ic('warn', 15) + ' ' + h.staleSources.length + ' webhook source(s) stale or offline: ' + h.staleSources.slice(0, 5).map(function (s) { return esc(s.tenant_name + ' / ' + s.deployment_label); }).join(', ') + '</div>' : '') +
      '<div class="spread wrap" style="margin-bottom:12px"><div class="pills">' + [['all', 'All'], ['pending_activation', 'Pending'], ['active', 'Active'], ['suspended', 'Suspended'], ['flagged', 'Flagged']].map(function (f) {
        return '<button class="pill ' + (S.filter === f[0] ? 'active' : '') + '" data-act="filter" data-v="' + f[0] + '">' + f[1] + (f[0] !== 'all' && counts[f[0]] ? ' · ' + counts[f[0]] : '') + '</button>';
      }).join('') + '</div><input class="input" id="q" placeholder="Search business or email" value="' + esc(S.q) + '" style="width:260px;height:36px" /></div>' +
      '<div class="table-wrap">' + (!list ? '<div class="small" style="padding:24px">Loading accounts…</div>' : rows.length ? '<table class="adm-table"><thead><tr><th>Business</th><th class="adm-hide-sm">Owner</th><th>Plan</th><th>Status</th><th class="adm-hide-sm">Leads</th><th class="adm-hide-sm">Created</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
        rows.map(function (a) {
          return '<tr data-act="detail" data-id="' + a.id + '"><td><b>' + esc(a.businessName) + '</b></td><td class="adm-hide-sm"><div>' + esc(a.ownerName) + '</div><div class="ts">' + esc(a.ownerEmail) + '</div></td>' +
            '<td>' + cap(a.plan) + (a.monthlyFee != null ? ' <span class="ts">$' + a.monthlyFee + '/mo</span>' : '') + '</td><td>' + badge(a.status) + '</td><td class="adm-hide-sm">' + a.leadCount + '</td><td class="adm-hide-sm ts">' + fmtDate(a.createdAt) + '</td>' +
            '<td style="text-align:right"><div class="adm-actions" style="justify-content:flex-end">' + actions(a) + '</div></td></tr>';
        }).join('') + '</tbody></table>' : '<div class="small" style="padding:24px">No accounts match.</div>') + '</div></div>';
  }

  function actions(a) {
    var out = [];
    if (a.status !== 'active') out.push('<button class="btn btn-primary btn-sm" data-act="status" data-id="' + a.id + '" data-v="activate">Activate</button>');
    if (a.status !== 'suspended') out.push('<button class="btn btn-ghost btn-sm" data-act="status" data-id="' + a.id + '" data-v="suspend">Suspend</button>');
    if (a.status !== 'flagged') out.push('<button class="btn btn-ghost btn-sm" data-act="status" data-id="' + a.id + '" data-v="flag">Flag</button>');
    return out.join('');
  }

  function detailDrawer(d) {
    return '<div class="scrim" data-act="close"></div><aside class="drawer w520"><div class="drawer-head"><div><div class="h2">' + esc(d.businessName) + '</div><div class="row" style="margin-top:6px">' + badge(d.status) + '<span class="chip">' + cap(d.plan) + '</span></div></div><button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div>' +
      '<div class="drawer-body"><dl class="kv"><dt>Owner</dt><dd>' + esc(d.ownerName) + ' · ' + esc(d.ownerEmail) + '</dd><dt>Created</dt><dd>' + fmtDate(d.createdAt) + '</dd><dt>Activated</dt><dd>' + fmtDate(d.activatedAt) + '</dd>' +
      '<dt>Deployments</dt><dd>' + d.deploymentCount + '</dd><dt>Leads</dt><dd>' + d.leadCount + '</dd><dt>Own AI key</dt><dd>' + (d.aiKeyConfigured ? 'Yes' : 'No') + '</dd>' +
      '<dt>Polar customer</dt><dd class="mono">' + esc(d.polarCustomerId || '—') + '</dd><dt>Polar subscription</dt><dd class="mono">' + esc(d.polarSubscriptionId || '—') + '</dd></dl>' +
      '<div class="adm-actions" style="margin-top:20px">' + actions(d) + '</div>' +
      '<div class="card" style="margin-top:20px"><div class="label">Monthly fee override (USD)</div><div class="row" style="margin-top:8px"><input class="input" id="fee" type="number" min="0" step="1" value="' + (d.monthlyFee != null ? d.monthlyFee : '') + '" style="width:140px" /><button class="btn btn-primary btn-sm" data-act="pricing" data-id="' + d.id + '">Save fee</button></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="label">Internal note</div><textarea class="input" id="note" style="margin-top:8px" placeholder="Visible to Super Admins only"></textarea><div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" data-act="note" data-id="' + d.id + '">Add note</button></div></div>' +
      '<div class="label" style="margin:24px 0 8px">History</div>' + (d.history.length ? d.history.map(function (h) { return '<div class="log"><span class="mono">' + fmtDate(h.createdAt) + '</span><span><b>' + esc(h.action.replace(/_/g, ' ')) + '</b>' + (h.note ? ' — ' + esc(h.note) : '') + '</span></div>'; }).join('') : '<div class="small">No admin actions yet.</div>') +
      '</div></aside>';
  }

  // ---------------------------------------------------------------- data
  function load() {
    return Promise.all([api('/admin/api/accounts?limit=100'), api('/admin/api/health')]).then(function (r) {
      S.accounts = r[0].data; S.health = r[1]; render();
    }, function (e) { toast(e.message, 'error'); });
  }
  function openDetail(id) {
    return api('/admin/api/accounts/' + id).then(function (d) { S.detail = d; overlay.innerHTML = detailDrawer(d); }, function (e) { toast(e.message, 'error'); });
  }

  function render() {
    root.innerHTML = S.token ? consoleView() : loginView();
    if (!S.token) { overlay.innerHTML = ''; var f = root.querySelector(S.email ? 'input[name=password]' : 'input[name=email]'); if (f) f.focus(); }
  }

  // ---------------------------------------------------------------- events
  document.addEventListener('submit', function (e) {
    if (e.target.id !== 'loginForm') return;
    e.preventDefault();
    var d = Object.fromEntries(new FormData(e.target));
    S.email = d.email;
    var btn = e.target.querySelector('button'); btn.disabled = true;
    api('/admin/api/login', { method: 'POST', body: { email: d.email, password: d.password, code: String(d.code).trim() } }).then(function (r) {
      S.token = r.token; save(r.token); S.error = null; render(); load();
    }, function (x) { S.error = x.message; btn.disabled = false; render(); });
  });
  document.addEventListener('input', function (e) {
    if (e.target.id === 'q') { S.q = e.target.value.toLowerCase(); var pos = e.target.selectionStart; render(); var q = document.getElementById('q'); q.focus(); q.setSelectionRange(pos, pos); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') overlay.innerHTML = ''; });
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    if (act !== 'detail' && el.closest('tr')) e.stopPropagation();
    switch (act) {
      case 'refresh': load(); break;
      case 'logout': S.token = null; save(null); render(); break;
      case 'filter': S.filter = v; render(); break;
      case 'detail': if (!e.target.closest('button')) openDetail(id); break;
      case 'close': overlay.innerHTML = ''; S.detail = null; break;
      case 'status':
        if (v !== 'activate' && !confirm(cap(v) + ' this account? ' + (v === 'suspend' ? 'Its pages stay live for 7 days, then go offline until reactivated.' : ''))) break;
        el.disabled = true;
        api('/admin/api/accounts/' + id + '/' + v, { method: 'POST' }).then(function () {
          toast('Account ' + (v === 'activate' ? 'activated' : v === 'suspend' ? 'suspended' : 'flagged'));
          load(); if (S.detail && S.detail.id === id) openDetail(id);
        }, function (x) { el.disabled = false; toast(x.message, 'error'); });
        break;
      case 'pricing':
        var fee = Number(document.getElementById('fee').value);
        if (!(fee >= 0)) { toast('Enter a fee of 0 or more.', 'error'); break; }
        api('/admin/api/accounts/' + id + '/pricing', { method: 'PATCH', body: { monthlyFee: fee } }).then(function () { toast('Fee saved'); load(); openDetail(id); }, function (x) { toast(x.message, 'error'); });
        break;
      case 'note':
        var note = document.getElementById('note').value.trim();
        if (!note) break;
        api('/admin/api/accounts/' + id + '/note', { method: 'POST', body: { note: note } }).then(function () { toast('Note added'); openDetail(id); }, function (x) { toast(x.message, 'error'); });
        break;
    }
  });

  render();
  if (S.token) load();
})();
