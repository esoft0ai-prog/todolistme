/* Camplo Super Admin console (ADL D-33: separate auth route, email + password + TOTP; D-23).
   Accounts: status, plan, limits, owner details, fees, notes. Platform: branding, pricing & limits, payments,
   email, AI, Telegram, signup. Aggregate data only — never lead or page content (ADL §7 #5). */
(function () {
  'use strict';
  var root = document.getElementById('root');
  var overlay = document.getElementById('overlay');
  var ic = window.CamploIcons.ic;
  var TOKEN_KEY = 'camplo-admin-token';
  var PLANS = ['starter', 'growth', 'watchtower', 'agency'];
  var S = { token: read(), view: 'accounts', section: 'branding', accounts: null, health: null, platform: null, history: [], filter: 'all', q: '', detail: null, error: null, email: '' };

  function read() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function save(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(d) { return d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
  function $(id) { return document.getElementById(id); }

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
    $('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 220); }, 3500);
  }

  // ---------------------------------------------------------------- login
  function loginView() {
    return '<div class="auth"><div class="auth-card"><div class="auth-logo">C<span>.</span></div>' +
      '<div style="text-align:center"><div class="h2">Super Admin</div><div class="small">Email, password and your authenticator code.</div></div>' +
      '<form class="col gap16" id="loginForm">' +
      '<div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="username" required value="' + esc(S.email) + '" /></div>' +
      '<div class="field"><label>Password</label><input class="input" name="password" type="password" autocomplete="current-password" required /></div>' +
      '<div class="field"><label>6-digit code</label><input class="input mono" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required /></div>' +
      (S.error ? '<span class="errmsg">' + esc(S.error) + '</span>' : '') +
      '<button class="btn btn-primary btn-full" type="submit">Sign in</button></form>' +
      '<a class="small" href="/" style="text-align:center">← Back to the app</a></div></div>';
  }

  // ---------------------------------------------------------------- shell
  function shell(body) {
    var brand = S.platform ? S.platform.branding.values.productName : 'Camplo';
    return '<div class="adm-wrap">' +
      '<div class="adm-head"><div class="row gap12"><div class="logo">' + esc(brand.charAt(0).toUpperCase()) + '<span>.</span></div><div><div class="h1" style="font-size:24px">Super Admin</div><div class="small">' + esc(brand) + ' platform control</div></div></div>' +
      '<div class="row"><button class="btn btn-ghost btn-sm" data-act="refresh">' + ic('refresh', 14) + ' Refresh</button><button class="btn btn-ghost btn-sm" data-act="logout">Sign out</button></div></div>' +
      '<nav class="settings-tabs" style="margin-bottom:24px">' + [['accounts', 'Accounts'], ['platform', 'Platform settings'], ['audit', 'Audit log']].map(function (t) {
        return '<button class="subtab ' + (S.view === t[0] ? 'active' : '') + '" data-act="view" data-v="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</nav>' + body + '</div>';
  }

  // ---------------------------------------------------------------- accounts
  var STATUS = { active: 'b-green', pending_activation: 'b-amber', suspended: 'b-red', flagged: 'b-purple' };
  function badge(st) { return '<span class="badge ' + (STATUS[st] || 'b-grey') + '">' + esc(st.replace('_', ' ')) + '</span>'; }

  function accountsView() {
    var h = S.health, list = S.accounts;
    var tiles = h ? [['Leads ingested today', h.leadsIngestedToday], ['Ingestion error rate (24h)', (h.ingestionErrorRate24h * 100).toFixed(1) + '%'], ['Active webhook sources', h.activeWebhookSources], ['Queue depth', h.queueDepth + (h.queueWarning ? ' ⚠' : '')]] : [];
    var rows = (list || []).filter(function (a) { return (S.filter === 'all' || a.status === S.filter) && (!S.q || (a.businessName + ' ' + a.ownerEmail).toLowerCase().indexOf(S.q) >= 0); });
    var counts = {}; (list || []).forEach(function (a) { counts[a.status] = (counts[a.status] || 0) + 1; });
    return '<div class="adm-tiles">' + (h ? tiles.map(function (t) { return '<div class="card"><div class="label">' + t[0] + '</div><b>' + esc(t[1]) + '</b></div>'; }).join('') : '<div class="small">Loading health…</div>') + '</div>' +
      (h && h.staleSources.length ? '<div class="banner amber" style="margin-bottom:24px">' + ic('warn', 15) + ' ' + h.staleSources.length + ' webhook source(s) stale or offline: ' + h.staleSources.slice(0, 5).map(function (s) { return esc(s.tenant_name + ' / ' + s.deployment_label); }).join(', ') + '</div>' : '') +
      '<div class="spread wrap" style="margin-bottom:12px"><div class="pills">' + [['all', 'All'], ['pending_activation', 'Pending'], ['active', 'Active'], ['suspended', 'Suspended'], ['flagged', 'Flagged']].map(function (f) {
        return '<button class="pill ' + (S.filter === f[0] ? 'active' : '') + '" data-act="filter" data-v="' + f[0] + '">' + f[1] + (f[0] !== 'all' && counts[f[0]] ? ' · ' + counts[f[0]] : '') + '</button>';
      }).join('') + '</div><input class="input" id="q" placeholder="Search business or email" value="' + esc(S.q) + '" style="width:260px;height:36px" /></div>' +
      '<div class="table-wrap">' + (!list ? '<div class="small" style="padding:24px">Loading accounts…</div>' : rows.length ? '<table class="adm-table"><thead><tr><th>Business</th><th class="adm-hide-sm">Owner</th><th>Plan</th><th>Status</th><th class="adm-hide-sm">Leads</th><th class="adm-hide-sm">Created</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
        rows.map(function (a) {
          return '<tr data-act="detail" data-id="' + a.id + '"><td><b>' + esc(a.businessName) + '</b></td><td class="adm-hide-sm"><div>' + esc(a.ownerName) + '</div><div class="ts">' + esc(a.ownerEmail) + '</div></td>' +
            '<td>' + cap(a.plan) + (a.monthlyFee != null ? ' <span class="ts">$' + a.monthlyFee + '/mo</span>' : '') + '</td><td>' + badge(a.status) + '</td><td class="adm-hide-sm">' + a.leadCount + '</td><td class="adm-hide-sm ts">' + fmtDate(a.createdAt) + '</td>' +
            '<td style="text-align:right"><div class="adm-actions" style="justify-content:flex-end">' + actions(a) + '</div></td></tr>';
        }).join('') + '</tbody></table>' : '<div class="small" style="padding:24px">No accounts match.</div>') + '</div>';
  }

  function actions(a) {
    var out = [];
    if (a.status !== 'active') out.push('<button class="btn btn-primary btn-sm" data-act="status" data-id="' + a.id + '" data-v="activate">Activate</button>');
    if (a.status !== 'suspended') out.push('<button class="btn btn-ghost btn-sm" data-act="status" data-id="' + a.id + '" data-v="suspend">Suspend</button>');
    if (a.status !== 'flagged') out.push('<button class="btn btn-ghost btn-sm" data-act="status" data-id="' + a.id + '" data-v="flag">Flag</button>');
    return out.join('');
  }

  function field(label, id, value, attrs) { return '<div class="field"><label>' + label + '</label><input class="input" id="' + id + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + ' /></div>'; }

  function detailDrawer(d) {
    return '<div class="scrim" data-act="close"></div><aside class="drawer w520"><div class="drawer-head"><div><div class="h2">' + esc(d.businessName) + '</div><div class="row" style="margin-top:6px">' + badge(d.status) + '<span class="chip">' + cap(d.plan) + '</span></div></div><button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div>' +
      '<div class="drawer-body"><dl class="kv"><dt>Created</dt><dd>' + fmtDate(d.createdAt) + '</dd><dt>Activated</dt><dd>' + fmtDate(d.activatedAt) + '</dd>' +
      '<dt>Deployments</dt><dd>' + d.deploymentCount + '</dd><dt>Leads</dt><dd>' + d.leadCount + '</dd><dt>Own AI key</dt><dd>' + (d.aiKeyConfigured ? 'Yes' : 'No') + '</dd>' +
      '<dt>Polar customer</dt><dd class="mono">' + esc(d.polarCustomerId || '—') + '</dd><dt>Polar subscription</dt><dd class="mono">' + esc(d.polarSubscriptionId || '—') + '</dd></dl>' +
      '<div class="adm-actions" style="margin-top:20px">' + actions(d) + '</div>' +
      '<div class="card" style="margin-top:20px"><div class="h3">Edit account</div><div class="form-grid" style="margin-top:12px">' +
      field('Business name', 'a_name', d.businessName) + field('Owner name', 'a_owner', d.ownerName) + field('Owner email', 'a_email', d.ownerEmail, 'type="email"') +
      '<div class="field"><label>Plan</label><select class="select" id="a_plan">' + PLANS.map(function (p) { return '<option value="' + p + '"' + (p === d.plan ? ' selected' : '') + '>' + cap(p) + '</option>'; }).join('') + '</select></div>' +
      field('Monthly fee override (blank = plan price)', 'a_fee', d.monthlyFee, 'type="number" min="0" step="1"') +
      field('Storage quota (GB)', 'a_quota', d.storageQuotaGb, 'type="number" min="0.1" step="0.5"') +
      field('Notification email', 'a_notify', d.notificationEmail, 'type="email"') +
      field('SLA threshold (minutes)', 'a_sla', d.slaThresholdMinutes, 'type="number" min="1"') +
      '</div><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary btn-sm" data-act="saveAccount" data-id="' + d.id + '">Save changes</button></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="label">Internal note</div><textarea class="input" id="note" style="margin-top:8px" placeholder="Visible to Super Admins only"></textarea><div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn btn-primary btn-sm" data-act="note" data-id="' + d.id + '">Add note</button></div></div>' +
      '<div class="label" style="margin:24px 0 8px">History</div>' + historyList(d.history) + '</div></aside>';
  }

  function historyList(h) {
    return h && h.length ? h.map(function (x) { return '<div class="log"><span class="mono">' + fmtDate(x.createdAt) + '</span><span><b>' + esc(x.action.replace(/_/g, ' ')) + '</b>' + (x.note ? ' — ' + esc(x.note) : '') + '</span></div>'; }).join('') : '<div class="small">Nothing yet.</div>';
  }

  // ---------------------------------------------------------------- platform settings
  var SECTION_LABELS = [['branding', 'Branding'], ['pricing', 'Pricing & limits'], ['billing', 'Payments (Polar)'], ['email', 'Email'], ['ai', 'AI'], ['telegram', 'Telegram'], ['signup', 'Signup']];

  function secretField(section, key, label) {
    var sec = S.platform[section].secrets[key] || {};
    var src = sec.source === 'admin' ? '<span class="badge b-green nodot">Set here</span>' : sec.source === 'env' ? '<span class="badge b-blue nodot">From environment</span>' : '<span class="badge b-grey nodot">Not set</span>';
    return '<div class="field"><div class="spread"><label>' + label + '</label>' + src + '</div><div class="row"><input class="input mono" type="password" data-secret="' + key + '" placeholder="' + esc(sec.masked ? sec.masked + ' — leave blank to keep' : 'Paste value') + '" autocomplete="off" style="font-size:12px" />' +
      (sec.source === 'admin' ? '<button class="btn btn-ghost btn-sm" data-act="clearSecret" data-v="' + key + '" title="Remove the value set here (falls back to the environment)">Clear</button>' : '') + '</div></div>';
  }
  function textField(key, label, value, attrs) { return '<div class="field"><label>' + label + '</label><input class="input" data-k="' + key + '" value="' + esc(value == null ? '' : value) + '" ' + (attrs || '') + ' /></div>'; }
  function toggle(key, label, on, hint) { return '<div class="setting-row"><div><b>' + label + '</b>' + (hint ? '<div class="small">' + hint + '</div>' : '') + '</div><button class="toggle ' + (on ? 'on' : '') + '" data-k="' + key + '" data-act="toggle"></button></div>'; }
  function testBtn(target, label) { return '<button class="btn btn-ghost btn-sm" data-act="test" data-v="' + target + '">' + (label || 'Test connection') + '</button>'; }

  function platformView() {
    if (!S.platform) return '<div class="small">Loading settings…</div>';
    var sec = S.section, v = S.platform[sec].values, body = '';
    if (sec === 'branding') {
      body = '<div class="small" style="margin-bottom:16px">The product name replaces "Camplo" across the app, emails, share pages and retrospective PDFs.</div><div class="form-grid">' +
        textField('productName', 'Product / system name', v.productName, 'maxlength="60"') + textField('tagline', 'Tagline', v.tagline, 'maxlength="160"') +
        textField('supportEmail', 'Support email', v.supportEmail, 'type="email"') + textField('emailFromName', 'Email sender name', v.emailFromName, 'maxlength="80"') + '</div>';
    } else if (sec === 'pricing') {
      var lim = function (p, k) { var n = v.plans[p].limits[k]; return '<input class="input" style="width:90px" type="number" min="-1" data-plan="' + p + '" data-limit="' + k + '" value="' + (n < 0 ? '' : n) + '" placeholder="∞" />'; };
      body = '<div class="small" style="margin-bottom:16px">Prices show on signup, upgrade and plan screens; limits are enforced immediately. Leave a limit blank for unlimited. Keep Polar product prices in step — Polar is what actually charges.</div>' +
        '<div class="row" style="margin-bottom:16px"><div class="field" style="width:160px"><label>Currency (ISO)</label><input class="input" data-k="currency" value="' + esc(v.currency) + '" maxlength="3" /></div>' +
        '<div class="field" style="width:260px"><label>Extra deployment add-on (per month)</label><input class="input" type="number" min="0" data-addon="extraDeploymentMonthly" value="' + v.addOns.extraDeploymentMonthly + '" /></div></div>' +
        '<div class="table-wrap"><table class="adm-table"><thead><tr><th>Plan</th><th>Price / month</th><th>Campaigns</th><th>Deployments</th><th>Team members</th><th>Connected tools</th><th>AI budget (USD/mo)</th></tr></thead><tbody>' +
        PLANS.map(function (p) {
          var pl = v.plans[p];
          return '<tr style="cursor:default"><td><b>' + cap(p) + '</b></td><td><input class="input" style="width:100px" type="number" min="0" data-plan="' + p + '" data-price value="' + pl.price + '" /></td>' +
            '<td>' + lim(p, 'campaigns') + '</td><td>' + lim(p, 'deployments') + '</td><td>' + lim(p, 'members') + '</td><td>' + lim(p, 'connectedTools') + '</td>' +
            '<td><input class="input" style="width:100px" type="number" min="0" step="0.5" data-plan="' + p + '" data-budget value="' + pl.deepBudgetUsd + '" /></td></tr>';
        }).join('') + '</tbody></table></div>';
    } else if (sec === 'billing') {
      body = '<div class="small" style="margin-bottom:16px">Polar.sh handles checkout and subscriptions. Set the Polar webhook endpoint to <span class="mono">' + esc(location.origin) + '/api/polar/webhook</span>.</div><div class="form-grid">' +
        secretField('billing', 'polarAccessToken', 'Polar access token') + secretField('billing', 'polarWebhookSecret', 'Polar webhook secret') +
        textField('polarOrganizationId', 'Polar organization ID', v.polarOrganizationId) + textField('polarApiUrl', 'Polar API URL', v.polarApiUrl, 'type="url"') + '</div>' +
        '<div class="label" style="margin:20px 0 8px">Product ID per plan</div><div class="form-grid">' + PLANS.map(function (p) { return '<div class="field"><label>' + cap(p) + '</label><input class="input mono" data-map="productIds" data-plan="' + p + '" value="' + esc(v.productIds[p] || '') + '" /></div>'; }).join('') + '</div>' +
        '<div class="label" style="margin:20px 0 8px">Static checkout link per plan (optional fallback)</div><div class="form-grid">' + PLANS.map(function (p) { return '<div class="field"><label>' + cap(p) + '</label><input class="input" type="url" data-map="checkoutUrls" data-plan="' + p + '" value="' + esc(v.checkoutUrls[p] || '') + '" /></div>'; }).join('') + '</div>' +
        toggle('allowDirectPlanChange', 'Allow plan changes without payment', v.allowDirectPlanChange, 'For demos and testing only — upgrades apply instantly and nothing is charged.');
    } else if (sec === 'email') {
      body = '<div class="small" style="margin-bottom:16px">SMTP is used when a host is set; otherwise Resend; otherwise emails are only logged.</div><div class="form-grid">' +
        textField('smtpHost', 'SMTP host', v.smtpHost) + textField('smtpPort', 'SMTP port', v.smtpPort, 'type="number" min="1" max="65535"') +
        textField('smtpUser', 'SMTP username', v.smtpUser, 'autocomplete="off"') + secretField('email', 'smtpPass', 'SMTP password') +
        textField('fromAddress', 'From address', v.fromAddress) + secretField('email', 'resendApiKey', 'Resend API key') + '</div>' +
        '<div class="row" style="margin-top:12px"><input class="input" id="testTo" type="email" placeholder="Send a test email to…" style="max-width:280px" />' + testBtn('email', 'Send test email') + '</div>';
    } else if (sec === 'ai') {
      body = '<div class="small" style="margin-bottom:16px">The platform AI key pays for workspaces without their own key. Models are OpenRouter model IDs per workload tier.</div><div class="form-grid">' +
        secretField('ai', 'openRouterApiKey', 'OpenRouter API key') + textField('defaultProvider', 'Default provider', v.defaultProvider) + '</div>' +
        '<div class="label" style="margin:20px 0 8px">Model per tier</div><div class="form-grid">' + ['quick', 'standard', 'deep', 'strategic'].map(function (t) { return '<div class="field"><label>' + cap(t) + '</label><input class="input mono" data-map="models" data-plan="' + t + '" value="' + esc(v.models[t] || '') + '" /></div>'; }).join('') + '</div>';
    } else if (sec === 'telegram') {
      body = '<div class="small" style="margin-bottom:16px">A platform-wide bot used by workspaces that haven\'t connected their own. Saving a token registers the webhook automatically.</div><div class="form-grid">' +
        secretField('telegram', 'botToken', 'Bot token') + secretField('telegram', 'webhookSecret', 'Webhook secret') + '</div>';
    } else if (sec === 'signup') {
      body = toggle('autoActivate', 'Activate new workspaces automatically', v.autoActivate, 'Off = new signups wait in Pending until you activate them (ADL D-27).') +
        '<div class="field" style="max-width:260px;margin-top:12px"><label>Default plan on the signup form</label><select class="select" data-k="defaultPlan">' + ['starter', 'growth', 'watchtower'].map(function (p) { return '<option value="' + p + '"' + (v.defaultPlan === p ? ' selected' : '') + '>' + cap(p) + '</option>'; }).join('') + '</select></div>';
    }
    var tests = { billing: testBtn('billing'), ai: testBtn('ai'), telegram: testBtn('telegram') }[sec] || '';
    return '<div class="dossier" style="grid-template-columns:220px minmax(0,1fr)"><div class="col gap4">' + SECTION_LABELS.map(function (s) {
      return '<button class="subtab ' + (sec === s[0] ? 'active' : '') + '" style="justify-content:flex-start;width:100%" data-act="section" data-v="' + s[0] + '">' + s[1] + (S.platform[s[0]].overridden.length ? ' <span class="dot b dot6" style="margin-left:6px"></span>' : '') + '</button>';
    }).join('') + '</div><div class="card" id="sectionForm">' + body +
      '<div class="row" style="justify-content:flex-end;margin-top:20px;gap:8px">' + tests + '<button class="btn btn-primary" data-act="saveSection">Save ' + esc(SECTION_LABELS.filter(function (s) { return s[0] === sec; })[0][1]) + '</button></div></div></div>';
  }

  /** Read the visible section form into the PATCH body. Blank plain fields reset to the environment default. */
  function collect(sec) {
    var f = $('sectionForm'), out = {};
    f.querySelectorAll('[data-k]').forEach(function (el) {
      var k = el.getAttribute('data-k');
      if (el.classList.contains('toggle')) { out[k] = el.classList.contains('on'); return; }
      var val = el.value.trim();
      out[k] = val === '' ? null : (el.type === 'number' ? Number(val) : val);
    });
    f.querySelectorAll('[data-secret]').forEach(function (el) { if (el.value.trim()) out[el.getAttribute('data-secret')] = el.value.trim(); });
    f.querySelectorAll('[data-map]').forEach(function (el) {
      var m = el.getAttribute('data-map'); out[m] = out[m] || {}; out[m][el.getAttribute('data-plan')] = el.value.trim();
    });
    if (sec === 'ai' && out.models) Object.keys(out.models).forEach(function (k) { if (!out.models[k]) delete out.models[k]; });
    if (sec === 'pricing') {
      out.plans = {};
      PLANS.forEach(function (p) { out.plans[p] = { limits: {} }; });
      f.querySelectorAll('[data-price]').forEach(function (el) { out.plans[el.getAttribute('data-plan')].price = Number(el.value || 0); });
      f.querySelectorAll('[data-budget]').forEach(function (el) { out.plans[el.getAttribute('data-plan')].deepBudgetUsd = Number(el.value || 0); });
      f.querySelectorAll('[data-limit]').forEach(function (el) { out.plans[el.getAttribute('data-plan')].limits[el.getAttribute('data-limit')] = el.value === '' ? -1 : Number(el.value); });
      out.addOns = {}; f.querySelectorAll('[data-addon]').forEach(function (el) { out.addOns[el.getAttribute('data-addon')] = Number(el.value || 0); });
      if (out.currency) out.currency = String(out.currency).toUpperCase();
    }
    return out;
  }

  function auditView() {
    return '<div class="card"><div class="h3" style="margin-bottom:12px">Platform changes</div>' + historyList(S.history) + '<div class="small" style="margin-top:12px">Account-level actions are in each account\'s History.</div></div>';
  }

  // ---------------------------------------------------------------- data
  function load() {
    return Promise.all([api('/admin/api/accounts?limit=100'), api('/admin/api/health'), api('/admin/api/platform')]).then(function (r) {
      S.accounts = r[0].data; S.health = r[1]; S.platform = r[2].sections; S.history = r[2].history; render();
    }, function (e) { toast(e.message, 'error'); });
  }
  function openDetail(id) {
    return api('/admin/api/accounts/' + id).then(function (d) { S.detail = d; overlay.innerHTML = detailDrawer(d); }, function (e) { toast(e.message, 'error'); });
  }
  function saveSection(values, label) {
    return api('/admin/api/platform/' + S.section, { method: 'PATCH', body: { values: values } }).then(function (r) {
      S.platform = r.sections; toast(label || 'Saved'); return api('/admin/api/platform').then(function (x) { S.history = x.history; render(); });
    }, function (x) { toast(x.message, 'error'); });
  }

  function render() {
    if (!S.token) { root.innerHTML = loginView(); overlay.innerHTML = ''; var f = root.querySelector(S.email ? 'input[name=password]' : 'input[name=email]'); if (f) f.focus(); return; }
    root.innerHTML = shell(S.view === 'platform' ? platformView() : S.view === 'audit' ? auditView() : accountsView());
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
    if (e.target.id === 'q') { S.q = e.target.value.toLowerCase(); var pos = e.target.selectionStart; render(); var q = $('q'); q.focus(); q.setSelectionRange(pos, pos); }
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
      case 'view': S.view = v; render(); break;
      case 'section': S.section = v; render(); break;
      case 'filter': S.filter = v; render(); break;
      case 'detail': if (!e.target.closest('button')) openDetail(id); break;
      case 'close': overlay.innerHTML = ''; S.detail = null; break;
      case 'toggle': el.classList.toggle('on'); break;
      case 'status':
        if (v !== 'activate' && !confirm(cap(v) + ' this account? ' + (v === 'suspend' ? 'Its pages stay live for 7 days, then go offline until reactivated.' : ''))) break;
        el.disabled = true;
        api('/admin/api/accounts/' + id + '/' + v, { method: 'POST' }).then(function () {
          toast('Account ' + (v === 'activate' ? 'activated' : v === 'suspend' ? 'suspended' : 'flagged'));
          load(); if (S.detail && S.detail.id === id) openDetail(id);
        }, function (x) { el.disabled = false; toast(x.message, 'error'); });
        break;
      case 'saveAccount':
        var fee = $('a_fee').value.trim(), quota = $('a_quota').value.trim(), sla = $('a_sla').value.trim();
        var body = { businessName: $('a_name').value.trim(), ownerName: $('a_owner').value.trim(), ownerEmail: $('a_email').value.trim(), plan: $('a_plan').value,
          monthlyFee: fee === '' ? null : Number(fee), notificationEmail: $('a_notify').value.trim() || undefined };
        if (quota) body.storageQuotaGb = Number(quota);
        if (sla) body.slaThresholdMinutes = Number(sla);
        el.disabled = true;
        api('/admin/api/accounts/' + id, { method: 'PATCH', body: body }).then(function (d) { toast('Account updated'); S.detail = d; overlay.innerHTML = detailDrawer(d); load(); }, function (x) { el.disabled = false; toast(x.message, 'error'); });
        break;
      case 'note':
        var note = $('note').value.trim();
        if (!note) break;
        api('/admin/api/accounts/' + id + '/note', { method: 'POST', body: { note: note } }).then(function () { toast('Note added'); openDetail(id); }, function (x) { toast(x.message, 'error'); });
        break;
      case 'saveSection': el.disabled = true; saveSection(collect(S.section)).then(function () { el.disabled = false; }); break;
      case 'clearSecret':
        if (!confirm('Remove this value? The environment variable (if any) applies again.')) break;
        var clear = {}; clear[v] = ''; saveSection(clear, 'Cleared');
        break;
      case 'test':
        el.disabled = true;
        api('/admin/api/platform/test/' + v, { method: 'POST', body: v === 'email' && $('testTo') && $('testTo').value ? { to: $('testTo').value } : {} }).then(function (r) {
          el.disabled = false;
          toast(r.ok ? 'Connection works' + (r.botUsername ? ' — @' + r.botUsername : r.via ? ' (' + r.via + ')' : '') : 'Test failed: ' + (r.error || 'check the values'), r.ok ? '' : 'error');
        }, function (x) { el.disabled = false; toast(x.message, 'error'); });
        break;
    }
  });

  render();
  if (S.token) load();
})();
