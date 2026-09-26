/* Camplo web client — talks to the Camplo API (/api). Vanilla JS, hash routing, no build step. */
(function () {
  'use strict';
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var ic = window.CamploIcons.ic, lifeIcon = window.CamploIcons.lifeIcon;
  var app = document.getElementById('app');
  var overlay = document.getElementById('overlay');

  // ================================================================ state
  var D = null;            // core workspace data (see loadCore)
  var C = {};              // lazily fetched per-screen data, keyed
  var pending = {};
  var S = {
    briefDismissed: store('camplo-brief') === new Date().toDateString(),
    insightFilter: 'All', leadFilter: { status: 'all', campaign: 'all', assignee: 'all', sort: 'newest' },
    slaTab: 'live', slaDay: null, chatOpen: false, depthOpen: false, depth: 'Standard', editNote: null, editingOverview: false,
    chatPending: false, uploadStep: 1, uploadId: null, refreshing: false,
  };

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }

  // ================================================================ API client
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    return fetch('/api' + path, init).then(function (res) {
      if (res.status === 401 && !opts.noRefresh && path.indexOf('/auth/') !== 0) {
        return fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' }).then(function (r) {
          if (r.ok) return api(path, Object.assign({}, opts, { noRefresh: true }));
          D = null; S.flash = 'Session expired. Please log in again.'; go('login');
          throw new Error('Session expired. Please log in again.');
        });
      }
      return res.text().then(function (t) {
        var j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        if (!res.ok) {
          var err = new Error((j && j.message) || ({ 413: 'Storage quota exceeded. Delete unused deployments to free space.', 500: 'Something went wrong on our end. Try again in a moment.' }[res.status]) || 'Connection issue. Check your network and try again.');
          err.status = res.status; err.data = j && j.data;
          if (res.status === 403 && j && j.data && j.data.reason === 'account_suspended') { D = null; S.flash = j.message; go('login'); }
          throw err;
        }
        return j;
      });
    }, function () { throw new Error('Connection issue. Check your network and try again.'); });
  }

  /** Fetch-once cache for screen data; re-renders when it arrives. */
  function lazy(key, path, map) {
    if (Object.prototype.hasOwnProperty.call(C, key)) return C[key];
    if (!pending[key]) {
      pending[key] = api(path).then(function (v) { C[key] = map ? map(v) : v; }, function (e) { C[key] = { __error: e.message, __status: e.status, __data: e.data }; })
        .then(function () { delete pending[key]; render(true); });
    }
    return undefined;
  }
  function inval(prefix) { Object.keys(C).forEach(function (k) { if (k.indexOf(prefix) === 0) delete C[k]; }); }

  // ================================================================ data mapping (API → view model)
  var ms = function (d) { return d ? new Date(d).getTime() : null; };
  var HEALTH = { healthy: 'HEALTHY', watch: 'WATCH', critical: 'CRITICAL' };
  function stripHtml(h) { var d = document.createElement('div'); d.innerHTML = h || ''; return (d.textContent || '').trim(); }
  function mapCampaign(c) {
    return {
      id: c.id, name: c.name, health: c.health ? HEALTH[c.health] : null, status: c.status.toUpperCase(), pinned: c.pinned, desc: stripHtml(c.description), brief: c.description,
      avgResp: c.avgResponseMs == null ? null : Math.round(c.avgResponseMs / 1000), budget: c.budget, daily: c.dailySpend, cplThreshold: c.cplThreshold, cpl: c.cpl,
      currency: c.currency, leads: c.leadCount, responded: c.respondedCount, start: c.startDate, end: c.completedAt, owner: c.ownerId, members: c.members,
      pages: c.pageCount, notes: c.notesCount, retro: c.retrospectiveReady, days: c.daysActive, share: c.shareLinkActive, signals: c.healthSignals,
    };
  }
  function mapLead(l) {
    return {
      id: l.id, displayId: l.displayId, campaign: l.campaignId, campaignName: l.campaignName, name: l.name, email: l.email, phone: l.phone,
      arrived: ms(l.receivedAt), assignee: l.assigneeId, assigneeName: l.assigneeName, path: l.assignmentPath,
      assignedAt: ms(l.reassignedAt || l.assignedAt || l.claimedAt), respondedAt: ms(l.respondedAt), respondedBy: l.respondedBy, respondedByName: l.respondedByName,
      page: l.pageName, deploymentId: l.deploymentId, deploymentDeleted: l.deploymentDeleted, source: l.sourceSystem, sourceId: l.sourceIdentifier,
      utm: l.utm, utmLocked: l.utmLocked, external: l.hasExternalLifecycleEvents, vip: l.vip, canRespond: l.canRespond, thr: l.thresholdMinutes, overdue: l.isOverdue,
    };
  }
  function mapInsight(i) {
    return { id: i.id, kind: i.type, priority: i.type === 'priority_flag', type: i.severity, camp: i.campaign_id, tag: i.campaign_tag, cat: i.category || 'Performance', t: ms(i.generated_at), obs: i.observation, ev: i.evidence, reassess: i.reassess_condition };
  }
  var HOOK = { operational: 'healthy', stale: 'warning', offline: 'offline', never_connected: 'never' };
  function mapPage(p) {
    return {
      id: p.id, name: p.name, camp: p.campaignId, campName: p.campaignName, status: p.servingState.toUpperCase(), deploy: p.status, hook: HOOK[p.webhook.state], ping: ms(p.webhook.lastReceivedAt),
      visits: p.analytics.visits7d, leads: p.analytics.leads7d, conv: p.analytics.conversionRate, above: p.analytics.aboveAverage, rollback: p.hasRollbackAvailable, prevAt: p.previousDeployedAt,
      watch72: p.earlyWarningActive && p.earlyWarningTriggered, url: p.url, host: p.host, subdomain: p.subdomain, webhookUrl: p.webhook.url, secret: p.webhook.secret, vip: p.vip, domain: p.domain,
    };
  }
  function mapMember(m) {
    var p = m.performance || {};
    return {
      id: m.id, name: m.name, email: m.email, role: m.role.toUpperCase(), initials: m.initials, lastActive: ms(m.lastActiveAt),
      week: p.avgThisWeekMs == null ? null : Math.round(p.avgThisWeekMs / 1000), avg30: p.avg30dMs == null ? null : Math.round(p.avg30dMs / 1000),
      ackRate: p.acknowledgmentRate == null ? null : Math.round(p.acknowledgmentRate * 100), breaches: p.breachesThisWeek || 0,
      fastest: p.fastestThisWeekMs, respondedWeek: p.respondedThisWeek || 0,
    };
  }

  /** Load the workspace-wide data every screen relies on. */
  function loadCore() {
    return Promise.all([
      api('/auth/me'), api('/workspace'), api('/campaigns'), api('/leads?limit=200'), api('/insights'), api('/recommendations'),
      api('/pages'), api('/team/members'), api('/sla/live'), api('/notifications'),
      api('/team-notes').catch(function () { return []; }),
    ]).then(function (r) {
      D = {
        me: r[0].user, ws: r[1], plan: r[1].plan, campaigns: r[2].map(mapCampaign), leadsEnv: r[3], leads: r[3].leads.map(mapLead),
        insights: r[4].map(mapInsight), recs: r[5], pages: r[6].pages.map(mapPage), accAvg: r[6].avgConversionRate, team: r[7].map(mapMember),
        live: r[8], notifs: r[9], teamNotes: r[10], slaMinutes: r[1].slaThresholdMinutes,
      };
      return D;
    });
  }

  var reloadTimer = null;
  function reload(soon) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(function () { if (D) loadCore().then(function () { render(true); }, function () {}); }, soon ? 0 : 400);
  }

  // Real-time: SSE channels trigger a debounced reload of core data.
  var streams = [];
  function connectRT() {
    streams.forEach(function (s) { s.close(); });
    streams = ['leads', 'insights', 'overdue-count', 'notifications', 'team-notes'].map(function (ch) {
      var es = new EventSource('/api/rt/workspace/' + ch);
      es.addEventListener('update', function () { inval('lead:'); inval('camp:'); reload(); });
      return es;
    });
  }

  // ================================================================ utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function byId(list, id) { for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i]; return null; }
  function user(id) { return byId(D && D.team, id) || { name: 'Former member', initials: '·' }; }
  function camp(id) { return byId(D && D.campaigns, id); }
  var SYM = { NGN: '₦', USD: '$', GBP: '£', EUR: '€', KES: 'KSh ', GHS: 'GH₵', ZAR: 'R' };
  function money(n, cur) { if (n == null) return '—'; return (SYM[cur] || (cur ? cur + ' ' : '$')) + Math.round(n).toLocaleString('en-US'); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dur(msv, withSec) {
    if (msv == null) return '—';
    if (msv < 0) msv = 0;
    var s = Math.floor(msv / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + pad(m) + 'm' + (withSec ? ' ' + pad(sec) + 's' : '');
    if (m || !withSec) return m + 'm ' + pad(sec) + 's';
    return sec + 's';
  }
  function secs(n) { return n == null ? '—' : dur(n * 1000, true); }
  function ago(ts) {
    if (!ts) return 'never';
    var d = Date.now() - ts;
    if (d < MIN) return 'just now';
    if (d < HOUR) return Math.floor(d / MIN) + ' min ago';
    if (d < DAY) { var h = Math.floor(d / HOUR); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var dd = Math.floor(d / DAY); return dd === 1 ? 'Yesterday' : dd + ' days ago';
  }
  function clock(ts) { var d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function dayLabel(ts) {
    var d = new Date(ts), t = new Date(); t.setHours(0, 0, 0, 0);
    var diff = Math.round((t - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / DAY);
    if (diff <= 0) return 'Today'; if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  function fmtDate(ts) { return ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function speedClass(sec) { return sec == null ? 'muted' : sec < 300 ? 'green' : sec < 1800 ? 'amber' : 'red'; }
  function healthBadge(h) { return h ? '<span class="badge ' + ({ HEALTHY: 'b-green', WATCH: 'b-amber', CRITICAL: 'b-red' }[h]) + '">' + h + '</span>' : planChip('growth'); }
  function av(id, size) { var u = user(id); return '<span class="avatar ' + (size ? 's' + size : '') + '" title="' + esc(u.name) + '">' + esc(u.initials) + '</span>'; }
  function first(id) { return user(id).name.split(' ')[0]; }
  function isOwner() { return D && D.me.role === 'owner'; }
  function canManage() { return D && D.me.role !== 'member'; }
  var RANK = { starter: 0, growth: 1, watchtower: 2, agency: 3 };
  function planOk(min) { return D && RANK[D.plan] >= RANK[min]; }
  function planChip(p) { return '<span class="chip chip-plan tip" data-tip="Available on ' + cap(p) + ' — upgrade to unlock" data-act="upgrade" data-plan="' + p + '">' + cap(p) + '</span>'; }
  function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
  function isOverdue(l) { return !l.respondedAt && Date.now() - l.arrived > (l.thr || D.slaMinutes) * MIN; }
  function overdueLeads() { return D.leads.filter(isOverdue).sort(function (a, b) { return a.arrived - b.arrived; }); }
  function errBox(v) { return '<div class="banner red">' + ic('warn', 15) + esc(v.__error) + '</div>'; }
  function skel(n) { var s = ''; for (var i = 0; i < (n || 3); i++) s += '<div class="skel" style="height:56px;margin-bottom:10px;border-radius:12px"></div>'; return s; }
  function linkLead(l) { return '#/campaigns/' + (l.campaign || '_') + '/leads/' + l.id; }

  /** Minimal, safe markdown for AI messages: bold, italics, internal links, lists, paragraphs. */
  function md(text) {
    var out = [], list = null;
    esc(text).split('\n').forEach(function (line) {
      var inl = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)_(.+?)_(?=\s|$|[.,])/g, '$1<i>$2</i>')
        .replace(/\[([^\]]+)\]\((#\/[^)\s]+)\)/g, '<a href="$2" data-link>$1</a>');
      var m = line.match(/^\s*(\d+\.|[-•])\s+(.*)$/);
      if (m) {
        var tag = /\d/.test(m[1]) ? 'ol' : 'ul';
        if (!list || list.tag !== tag) { if (list) out.push('</' + list.tag + '>'); list = { tag: tag }; out.push('<' + tag + '>'); }
        out.push('<li>' + inl.replace(/^\s*(\d+\.|[-•])\s+/, '') + '</li>');
      } else {
        if (list) { out.push('</' + list.tag + '>'); list = null; }
        if (line.trim()) out.push('<p style="margin:0 0 8px">' + inl + '</p>');
      }
    });
    if (list) out.push('</' + list.tag + '>');
    return out.join('');
  }

  // ================================================================ routing
  function route() {
    var h = location.hash.replace(/^#\/?/, '') || 'dashboard';
    var parts = h.split('?');
    return { parts: parts[0].split('/'), query: new URLSearchParams(parts[1] || '') };
  }
  function go(path) { if (location.hash === '#/' + path) render(); else location.hash = '#/' + path; }

  var PUBLIC = { login: 1, signup: 1, forgot: 1, 'forgot-password': 1, 'reset-password': 1, pending: 1, share: 1, acknowledge: 1, 'accept-invite': 1 };

  function render(soft) {
    var r = route(), top = r.parts[0];
    if (!soft) closeOverlay();
    document.body.classList.toggle('has-mnav', !PUBLIC[top]);
    var html;
    if (PUBLIC[top]) html = publicScreen(top, r);
    else if (!D) { html = bootScreen(); boot(); }
    else html = shell(r.parts, r.query);
    var y = window.scrollY;
    app.innerHTML = html;
    if (soft) window.scrollTo(0, y); else window.scrollTo(0, 0);
    if (S.chatOpen && soft) refreshChat();
    tick(); tickSlow();
  }
  window.addEventListener('hashchange', function () { render(); });

  var booting = false;
  function boot() {
    if (booting) return;
    booting = true;
    loadCore().then(function () {
      booting = false;
      var t = D.ws;
      if (!t.setupComplete && route().parts[0] !== 'onboarding') { go('onboarding/1'); return; }
      connectRT(); render();
    }, function (e) {
      booting = false;
      if (e.status === 403 && e.data && e.data.reason === 'pending_activation') go('pending');
      else if (!D) go('login');
    });
  }
  function bootScreen() { return '<div class="auth"><div class="col" style="align-items:center;gap:16px"><div class="auth-logo">C<span>.</span></div><div class="load-dots"><i></i><i></i><i></i><i></i><i></i></div><div class="small">Opening the watchtower…</div></div></div>'; }

  // ================================================================ shell
  function shell(p, q) {
    var top = p[0], body;
    if (top === 'dashboard') body = dashboard();
    else if (top === 'leads' && p[1]) body = dossier(p[1]);
    else if (top === 'leads') body = leadInbox(q);
    else if (top === 'campaigns' && p[2] === 'leads' && p[3]) body = dossier(p[3]);
    else if (top === 'campaigns' && p[1]) body = campaignDetail(p[1], p[2] || 'overview');
    else if (top === 'pages') body = pagesScreen();
    else if (top === 'sla') { if (q.get('tab')) S.slaTab = q.get('tab') === 'config' ? 'config' : 'live'; body = slaScreen(); }
    else if (top === 'team-notes') body = teamNotesScreen();
    else if (top === 'me' || top === 'my-performance') body = myPerformance();
    else if (top === 'settings') body = settingsScreen(p[1] || (isOwner() ? 'workspace' : 'team'));
    else if (top === 'onboarding') return onboarding(+p[1] || 1);
    else if (top === 'feed') body = mobileFeed();
    else body = '<div class="page">' + empty('target', 'Nothing here.', 'That screen does not exist.', '<a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a>') + '</div>';
    return topnav(top) + strip() + (D.ws.hasMarketingStack === false && D.ws.stackCheckCompleted && isOwner() && !S.stackBannerHidden
      ? '<div class="page" style="padding-bottom:0;padding-top:16px"><div class="banner amber">' + ic('warn', 15) + ' Connect a marketing tool to start receiving leads. <a href="#/settings/integrations">View setup guide</a><button class="x" data-act="hideStack">×</button></div></div>' : '') +
      '<main>' + body + '</main>' + dock() +
      '<button class="brain-fab" data-act="chat">' + ic('brain', 18) + '<span>Ask Camplo</span></button>' +
      '<nav class="mnav"><button class="' + (top === 'feed' || top === 'dashboard' ? 'active' : '') + '" data-go="feed">' + ic('feed', 20) + 'Feed</button><button data-act="chat">' + ic('chat', 20) + 'Chat</button></nav>';
  }

  function topnav(top) {
    var tabs = [['dashboard', 'Campaign'], ['leads', 'Leads'], ['pages', 'Pages'], ['sla', 'SLA'], ['team-notes', 'Team Notes']];
    var active = top === 'campaigns' ? 'dashboard' : top;
    var sp = D.live.avgResponseTime == null ? null : Math.round(D.live.avgResponseTime / 1000);
    var unread = D.notifs.unreadCount;
    var od = D.live.overdueCount;
    return '<header class="topnav">' +
      '<div class="logo" data-go="dashboard" aria-label="Camplo home">C<span>.</span></div>' +
      '<nav class="tabs">' + tabs.map(function (t) { return '<a class="tab ' + (active === t[0] ? 'active' : '') + '" href="#/' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' +
      '<div class="search" id="search"><span class="ico">' + ic('search', 15) + '</span><input id="searchInput" placeholder="Search campaigns, leads, pages" autocomplete="off" /><kbd>⌘K</kbd></div>' +
      '<div class="nav-right">' +
      (od ? '<div class="mobile-only row"><span class="badge b-red b-bold">' + od + ' overdue</span></div>' : '') +
      '<div class="stl" data-go="sla" title="Workspace Speed-to-Lead"><span class="label">Avg response</span><b class="' + speedClass(sp) + '">' + secs(sp) + '</b></div>' +
      '<button class="iconbtn" data-act="notifs" aria-label="Notifications">' + ic('bell', 18) + (unread ? '<span class="dot-badge">' + unread + '</span>' : '') + '</button>' +
      '<span class="avatar me" data-act="usermenu">' + esc(D.me.initials) + '</span>' +
      '</div></header>';
  }

  function strip() {
    var od = D.live.overdueCount;
    var unclaimed = D.leads.filter(function (l) { return !l.respondedAt && !l.assignee; }).length;
    var offline = D.pages.filter(function (p) { return p.hook === 'offline' && p.status === 'ACTIVE'; }).length;
    var today = D.leads.filter(function (l) { return Date.now() - l.arrived < DAY; }).length;
    var over = D.campaigns.filter(function (c) { return c.cpl != null && c.cplThreshold != null && c.cpl > c.cplThreshold; })[0];
    var tools = (D.ws.limits && true) ? D.pages.filter(function (p) { return p.status === 'ACTIVE'; }).length : 0;
    return '<div class="strip">' +
      '<div class="strip-item strip-live"><span class="dot g pulse-slow"></span> Watching ' + D.campaigns.filter(function (c) { return c.status !== 'COMPLETE'; }).length + ' campaigns · ' + tools + ' live pages</div>' +
      '<div class="strip-item" data-go="sla"><span class="dot r ' + (od ? 'pulse-fast' : '') + '"></span><b>' + od + '</b> overdue</div>' +
      '<div class="strip-item" data-go="leads?status=unassigned"><span class="dot o ' + (unclaimed ? 'pulse-orange' : '') + '"></span><b>' + unclaimed + '</b> unclaimed</div>' +
      '<div class="strip-item" data-go="pages"><span class="dot ' + (offline ? 'r' : 'g') + '"></span><b>' + offline + '</b> webhook offline</div>' +
      '<div class="strip-item" data-go="leads"><b>' + today + '</b> leads today</div>' +
      (over ? '<div class="strip-item" data-go="campaigns/' + over.id + '/overview">' + esc(over.name) + ' CPL <b class="amber">' + money(over.cpl, over.currency) + '</b></div>' : '') +
      '<div class="strip-item strip-live">Plan: ' + cap(D.plan) + '</div>' +
      '</div>';
  }

  function dock() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return '<div class="dock">' +
      '<button class="iconbtn tip" data-tip="Webhooks & API" data-go="settings/webhooks">' + ic('link', 17) + '</button>' +
      '<button class="iconbtn tip" data-tip="' + (light ? 'Dark mode' : 'Light mode') + '" data-act="theme">' + ic(light ? 'moon' : 'sun', 17) + '</button>' +
      '<button class="iconbtn tip" data-tip="Settings" data-go="settings">' + ic('gear', 17) + '</button></div>';
  }

  function empty(icon, h, p, action) {
    return '<div class="empty">' + ic(icon, 48, 'stroke-width="1.4"') + '<div class="h">' + h + '</div>' + (p ? '<p>' + p + '</p>' : '') + (action || '') + '</div>';
  }

  // ================================================================ insight + recommendation cards
  var ORDER = { red: 1, amber: 2, blue: 3, green: 4 };
  function sortInsights(list) {
    return list.slice().sort(function (a, b) {
      return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || (a.kind === 'insufficient_evidence' ? 1 : 0) - (b.kind === 'insufficient_evidence' ? 1 : 0) || ORDER[a.type] - ORDER[b.type] || b.t - a.t;
    });
  }
  function insightCard(i, idx, opts) {
    opts = opts || {};
    if (i.kind === 'insufficient_evidence') return monitoringCard(i);
    var c = camp(i.camp);
    return '<article class="insight t-' + i.type + (i.priority ? ' priority' : '') + (Date.now() - i.t < HOUR && !i.priority ? ' unread' : '') + '" style="animation-delay:' + (idx * 70) + 'ms">' +
      (i.priority ? '<div class="pf-label">' + ic('flag', 12) + ' Priority flag</div>' : '') +
      '<div class="obs">' + esc(i.obs) + '</div>' + (i.ev ? '<div class="ev">' + esc(i.ev) + '</div>' : '') +
      '<div class="meta">' + (c ? '<a class="chip chip-blue" href="#/campaigns/' + c.id + '/insights">' + esc(c.name) + '</a>' : (i.tag ? '<span class="chip chip-blue">' + esc(i.tag) + '</span>' : '')) + '<span class="ts" data-ago="' + i.t + '"></span>' +
      (opts.noActions ? '' : '<button class="linkbtn" style="margin-left:auto;color:var(--text-muted);font-size:12px" data-act="dismissInsight" data-id="' + i.id + '">Dismiss</button>') + '</div>' +
      (opts.noActions ? '' : '<button class="expand" data-act="insight" data-id="' + i.id + '" aria-label="Expand insight">' + ic('expand', 14) + '</button>') + '</article>';
  }
  function monitoringCard(i) {
    var c = camp(i.camp);
    return '<article class="rec mon"><span class="lvl muted">Monitoring</span>' +
      '<div style="font:italic 500 15px var(--f-display)">' + esc(i.obs) + '</div>' + (i.ev ? '<div class="small">' + esc(i.ev) + '</div>' : '') +
      (i.reassess ? '<div class="small">Camplo will reassess after ' + esc(i.reassess) + '.</div>' : '') +
      '<div class="meta row">' + (c ? '<a class="chip chip-blue" href="#/campaigns/' + c.id + '/insights">' + esc(c.name) + '</a>' : '') + '<span class="ts" data-ago="' + i.t + '"></span></div></article>';
  }
  function recCard(r, idx, expanded) {
    var lvlName = { 2: 'Tactical', 3: 'Diagnostic', 4: 'Strategic' }[r.level];
    var col = { 2: 'var(--accent-blue)', 3: 'var(--status-amber)', 4: '#A855F7' }[r.level];
    var conf = { low: 1, medium: 3, high: 5 }[r.confidence];
    var dots = ''; for (var i = 1; i <= 5; i++) dots += '<i style="' + (i <= conf ? 'background:' + col : '') + '"></i>';
    var mem = (r.memory_timeline || []).length ? '<button class="chip chip-blue" style="margin-top:10px;cursor:pointer" data-act="memory" data-id="' + r.recommendation_id + '">' + ic('clock', 11) + ' Based on campaign history</button>' : '';
    return '<article class="rec l' + r.level + '" id="rec-' + r.recommendation_id + '" style="animation-delay:' + (idx * 80) + 'ms">' +
      '<div class="spread"><span class="lvl" style="color:' + col + '">' + lvlName + '</span>' + (r.campaign_id ? '<a class="chip chip-blue" href="#/campaigns/' + r.campaign_id + '/insights">' + esc(r.campaign_name) + '</a>' : '<span class="chip">All campaigns</span>') + '</div>' +
      '<div class="action">' + esc(r.action_text) + '</div>' +
      '<div><div class="label">Why</div><div class="small" style="font-size:14px;margin-top:4px">' + esc(r.why) + '</div></div>' +
      collapsible('Evidence', '<ul>' + r.evidence.map(function (e) { return '<li><b>' + esc(e.metric) + '</b>: ' + esc(e.change) + ' <span class="muted">(' + esc(e.period) + ')</span></li>'; }).join('') + '</ul>' + mem, expanded) +
      (r.diagnosis ? collapsible('Diagnosis', '<p class="small" style="margin:8px 0 0">' + esc(r.diagnosis) + '</p>', expanded) : '') +
      '<div class="form-grid" style="gap:12px"><div><div class="label">Expected outcome</div><div class="small" style="margin-top:4px">' + esc(r.expected_outcome) + '</div></div><div><div class="label">Risk</div><div class="small" style="margin-top:4px">' + esc(r.risk) + '</div></div></div>' +
      '<div class="rec-foot"><span>Confidence <span class="conf">' + dots + '</span> ' + cap(r.confidence) + '</span><span>Next step: <span style="color:var(--text-primary)">' + esc(r.next_step) + '</span></span><span>Why now: ' + esc(r.why_now) + '</span></div>' +
      '<div class="row"><button class="btn btn-primary disabled" disabled title="Autopilot arrives in v2" style="cursor:not-allowed">Apply (Coming Soon)</button><button class="btn btn-ghost" data-act="dismissRec" data-id="' + r.recommendation_id + '">Dismiss</button>' +
      (expanded ? '' : '<button class="close" style="margin-left:auto" data-act="recExpand" data-id="' + r.recommendation_id + '" aria-label="Expand">' + ic('expand', 14) + '</button>') + '</div></article>';
  }
  function collapsible(label, body, open) {
    return '<div><button class="collapse-h' + (open ? ' open' : '') + '" data-act="collapse"><span class="label">' + label + '</span>' + ic('chev', 12) + '</button><div class="collapse-b' + (open ? ' open' : '') + '">' + body + '</div></div>';
  }

  // ================================================================ Dashboard (Screen 1 + Morning Brief)
  function dashboard() {
    var od = overdueLeads(), b = D.live.brief;
    var h = new Date().getHours(), greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    var mine = b.mySpeedYesterday == null ? null : Math.round(b.mySpeedYesterday / 1000), mine30 = b.mySpeed30d == null ? null : Math.round(b.mySpeed30d / 1000);
    var overnight = D.insights.filter(function (i) { return Date.now() - i.t < 6 * HOUR && i.kind !== 'insufficient_evidence'; }).slice(0, 3);
    var brief = S.briefDismissed || !planOk('growth') ? '' :
      '<section class="glass brief">' +
      '<button class="close brief-close" data-act="dismissBrief" aria-label="Dismiss brief">' + ic('x', 16) + '</button>' +
      '<div class="row gap12"><div class="brain-ico">' + ic('brain', 18) + '</div><div><div class="h1" style="font-size:24px">' + greet + ', ' + esc(D.me.name.split(' ')[0]) + '</div>' +
      '<div class="small">' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · Camplo has been watching since you left — here is what changed.</div></div></div>' +
      '<div class="brief-grid">' +
      '<div><div class="label">What happened yesterday</div><div class="brief-stat"><b>' + b.yesterday.received + '</b><span class="small">leads received</span></div><div class="small" style="margin-top:6px"><span class="green">' + b.yesterday.responded + ' responded</span> · <span class="' + (b.yesterday.slaBreaches ? 'red' : 'green') + '">' + b.yesterday.slaBreaches + ' SLA breaches</span> · ' + b.yesterday.campaignsFlagged + ' campaigns flagged</div></div>' +
      '<div><div class="label">Needs attention today</div><div class="brief-stat"><b class="' + (D.live.overdueCount ? 'red' : 'green') + '">' + D.live.overdueCount + '</b><span class="small">overdue leads</span></div>' +
      (b.mostOverdue ? '<div class="small" style="margin-top:6px">Most urgent: <a href="#/leads/' + b.mostOverdue.id + '">' + esc(b.mostOverdue.name) + '</a> · <span class="red" data-since="' + ms(b.mostOverdue.receivedAt) + '"></span></div>' : '') +
      (b.priorityFlags ? '<div class="small red" style="margin-top:4px">' + b.priorityFlags + ' Priority Flag' + (b.priorityFlags > 1 ? 's' : '') + ' active</div>' : '') + '</div>' +
      '<div><div class="label">AI noticed recently</div>' + (overnight.length ? '<ul style="margin:8px 0 0;padding-left:16px;font-size:13px;color:var(--text-secondary);line-height:1.6">' + overnight.map(function (i) { return '<li>' + esc(i.obs) + '</li>'; }).join('') + '</ul>' : '<div class="small" style="margin-top:8px">Nothing new in the last 6 hours.</div>') + '</div>' +
      '<div><div class="label">Your speed-to-lead (yesterday)</div><div class="brief-stat"><b class="' + speedClass(mine) + '">' + secs(mine) + '</b></div>' +
      (mine != null && mine30 != null ? '<div class="small" style="margin-top:6px"><span class="' + (mine <= mine30 ? 'green' : 'red') + '">' + ic(mine <= mine30 ? 'arrowDown' : 'arrowUp', 12) + ' ' + secs(Math.abs(mine30 - mine)) + '</span> ' + (mine <= mine30 ? 'faster' : 'slower') + ' than your 30-day avg</div>' : '<div class="small" style="margin-top:6px">No responses from you yesterday.</div>') + '</div>' +
      '</div></section>';

    var ins = sortInsights(D.insights);
    var offline = D.pages.filter(function (p) { return p.hook === 'offline' && p.status === 'ACTIVE'; });
    var watch = D.pages.filter(function (p) { return p.watch72; });
    var rules = (od.length ? '<div class="rule-strip red" data-go="leads?status=overdue">' + ic('clock', 15) + '<b>' + od.length + ' leads overdue</b> against your ' + D.slaMinutes + 'm threshold<span class="tag">Rule · live</span></div>' : '') +
      offline.map(function (p) { return '<div class="rule-strip amber" data-go="pages">' + ic('link', 15) + '<b>' + esc(p.name) + '</b> webhook offline · last ping <span data-ago="' + p.ping + '"></span><span class="tag">Rule · live</span></div>'; }).join('') +
      watch.map(function (p) { return '<div class="rule-strip amber" data-go="pages">' + ic('warn', 15) + '<b>72h watch:</b> ' + esc(p.name) + ' conversion dropped during its launch window<span class="tag">Rule · live</span></div>'; }).join('');

    var recs = D.recs.slice(0, 2);
    var intel = '<section class="glass intel">' +
      '<div class="spread"><div class="intel-head"><div class="brain-ico think">' + ic('brain', 18) + '</div><div><div class="h3">Camplo Intelligence</div><div class="watching" style="margin-top:2px">Watching your workplace</div></div></div>' +
      '<div class="row"><button class="btn btn-ghost btn-sm" data-act="refreshInsights" ' + (S.refreshing ? 'disabled' : '') + '>' + (S.refreshing ? '<span class="spinner" style="border-color:rgba(255,255,255,.2);border-top-color:var(--text-primary)"></span>' : ic('refresh', 14)) + ' Refresh</button><button class="btn btn-ghost btn-sm" data-act="chat">' + ic('chat', 14) + ' Ask</button></div></div>' +
      '<div class="feed">' + rules + (ins.length ? ins.map(function (i, x) { return insightCard(i, x); }).join('') : (rules ? '' : empty('brain', 'No insights yet.', 'Camplo will surface intelligence as your campaigns generate activity.'))) + '</div>' +
      (recs.length ? '<div class="section-label"><span class="label">Recommendations</span></div><div class="feed" style="margin-top:0">' + recs.map(function (r, i) { return recCard(r, i); }).join('') + '</div>' : '') +
      '</section>';

    var pinned = D.campaigns.filter(function (c) { return c.pinned; });
    var recent = D.campaigns.filter(function (c) { return !c.pinned; });
    var list = '<section>' +
      '<div class="spread" style="margin-bottom:12px"><div class="h2">Campaigns</div><div class="row"><span class="ts">Pinned | ' + pinned.length + ' of 3</span>' + (canManage() ? '<button class="btn btn-ghost btn-sm" data-act="newCampaign">' + ic('plus', 14) + ' New Campaign</button>' : '') + '</div></div>' +
      (D.campaigns.length ? '' : empty('target', 'No campaigns yet.', 'Create your first campaign to start monitoring.', canManage() ? '<button class="btn btn-primary" data-act="newCampaign">Create Campaign</button>' : '')) +
      '<div class="col gap12">' + pinned.map(campaignCard).join('') + '</div>' +
      (recent.length ? '<div class="section-label"><span class="label">Recent campaigns</span></div><div class="col gap12">' + recent.map(campaignCard).join('') + '</div>' : '') +
      '<div class="card" style="margin-top:16px;padding:16px"><div class="spread"><div class="row"><div class="stack">' + D.team.slice(0, 6).map(function (u) { return av(u.id, 28); }).join('') + '</div><span class="small">' + D.team.length + ' on the team</span></div>' + (canManage() ? '<button class="btn btn-ghost btn-sm" data-act="invite">+ Invite</button>' : '') + '</div></div>' +
      '</section>';
    return '<div class="page">' + brief + '<div class="cc">' + intel + list + '</div></div>';
  }

  function campaignCard(c) {
    var cls = c.status === 'COMPLETE' ? 'done' : c.health === 'CRITICAL' ? 'crit' : '';
    return '<article class="ccard ' + cls + '" data-go="campaigns/' + c.id + '/overview">' +
      '<div class="spread"><div class="h3">' + esc(c.name) + '</div><div class="row">' + (c.status === 'COMPLETE' ? '<span class="badge b-blue">Complete</span>' : healthBadge(c.health)) +
      (canManage() && c.status !== 'COMPLETE' ? '<button class="close tip" data-tip="' + (c.pinned ? 'Unpin' : 'Pin') + '" data-act="pin" data-id="' + c.id + '" data-v="' + (c.pinned ? '0' : '1') + '" style="color:' + (c.pinned ? 'var(--accent-orange)' : 'var(--text-muted)') + '">' + ic('flag', 13) + '</button>' : '') + '</div></div>' +
      (c.desc ? '<div class="desc">' + esc(c.desc) + '</div>' : '') +
      '<div class="row wrap gap12"><span class="small">Avg response: <b class="' + speedClass(c.avgResp) + '">' + secs(c.avgResp) + '</b></span>' + (c.cpl != null ? '<span class="ts">CPL: ' + money(c.cpl, c.currency) + '</span>' : '') + '<span class="ts">' + c.leads + ' leads</span></div>' +
      '<div class="foot"><div class="stack">' + c.members.slice(0, 3).map(function (m) { return av(m, 24); }).join('') + (c.members.length > 3 ? '<span class="avatar s24">+' + (c.members.length - 3) + '</span>' : '') + '</div>' +
      '<span class="ico-inline">' + ic('file', 13) + c.pages + ' pages</span><span class="ico-inline">' + ic('note', 13) + c.notes + ' notes</span><span style="margin-left:auto">' + fmtDate(c.start) + '</span></div>' +
      (c.retro ? '<div class="retro-chip">' + ic('file', 14) + ' Retrospective ready <span style="margin-left:auto">' + ic('download', 14) + '</span></div>' : '') +
      '</article>';
  }

  // ================================================================ Lead Inbox (Screen 2)
  function leadInbox(q) {
    if (q && q.get('status')) { S.leadFilter.status = q.get('status').toLowerCase(); }
    if (q && q.get('campaign_id')) S.leadFilter.campaign = q.get('campaign_id');
    var e = D.leadsEnv;
    return '<div class="page">' +
      '<div class="page-head"><div><h1 class="h1">Lead Inbox</h1><div class="watching">' + ic('brain', 14) + ' Watching your Lead Inbox</div></div></div>' +
      '<div class="kpis">' +
      '<div class="kpi"><div class="label">Total leads</div><div class="display">' + e.total + '</div><div class="kpi-sub">All time · avg response ' + secs(e.avg_response_time_seconds) + '</div></div>' +
      '<div class="kpi"><div class="label">Responded</div><div class="display green">' + e.responded + '</div><div class="kpi-sub">' + (e.total ? Math.round(e.responded / e.total * 100) : 0) + '% acknowledgment rate</div></div>' +
      '<div class="kpi dominant"><div class="label" style="color:var(--status-red)">Not responded</div><div class="display red">' + e.not_responded + '</div><div class="kpi-sub"><span class="red">' + e.overdue + ' overdue</span> · customers are waiting right now</div></div>' +
      '</div>' + leadFilters(true) + '<div id="leadTable">' + leadTable(filteredLeads(), false, e.has_more) + '</div></div>';
  }
  function leadFilters(withCampaign) {
    var f = S.leadFilter;
    function sel(k, opts) { return '<select class="select" data-filter="' + k + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (f[k] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; }
    return '<div class="filters">' +
      sel('status', [['all', 'All statuses'], ['not_responded', 'Not responded'], ['overdue', 'Overdue'], ['unassigned', 'Unassigned'], ['responded', 'Responded']]) +
      (withCampaign ? sel('campaign', [['all', 'All campaigns']].concat(D.campaigns.map(function (c) { return [c.id, c.name]; }))) : '') +
      sel('assignee', [['all', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned']].concat(D.team.map(function (u) { return [u.id, u.name]; }))) +
      sel('sort', [['newest', 'Newest first'], ['waiting', 'Longest waiting']]) + '</div>';
  }
  function filteredLeads(campId, list) {
    var f = S.leadFilter;
    list = (list || D.leads).filter(function (l) {
      if (campId && l.campaign !== campId) return false;
      if (!campId && f.campaign !== 'all' && l.campaign !== f.campaign) return false;
      if (f.status === 'not_responded' && l.respondedAt) return false;
      if (f.status === 'responded' && !l.respondedAt) return false;
      if (f.status === 'overdue' && !isOverdue(l)) return false;
      if (f.status === 'unassigned' && (l.assignee || l.respondedAt)) return false;
      if (f.assignee === 'me' && l.assignee !== D.me.id) return false;
      if (f.assignee === 'none' && l.assignee) return false;
      if (['all', 'me', 'none'].indexOf(f.assignee) < 0 && l.assignee !== f.assignee) return false;
      return true;
    });
    return list.sort(f.sort === 'waiting' ? function (a, b) { return (a.respondedAt ? 1 : 0) - (b.respondedAt ? 1 : 0) || a.arrived - b.arrived; } : function (a, b) { return b.arrived - a.arrived; });
  }
  function leadTable(list, hideCampaign, hasMore) {
    if (!list.length) {
      return '<div class="table-wrap">' + (D.leadsEnv.total ? empty('search', 'No leads match these filters.', '', '<button class="btn btn-ghost" data-act="clearFilters">Clear filters</button>')
        : empty('inbox', 'No leads yet.', 'Leads will appear when your pages receive submissions.', '<a class="btn btn-ghost" href="#/pages">Go to Pages</a>')) + '</div>';
    }
    return '<div class="table-wrap"><table><thead><tr><th>Lead</th>' + (hideCampaign ? '' : '<th>Campaign</th>') + '<th>Assignee</th><th>Seen</th><th>Status</th><th style="width:80px">Lifecycle</th></tr></thead><tbody>' +
      list.map(function (l) { return leadRow(l, hideCampaign); }).join('') + '</tbody></table>' +
      (hasMore ? '<div class="table-foot"><button class="btn btn-ghost btn-sm" data-act="loadMore">Load more</button></div>' : '<div class="table-foot">All ' + list.length + ' leads loaded</div>') + '</div>';
  }
  function leadRow(l, hideCampaign) {
    var od = isOverdue(l), open = !l.respondedAt;
    var assignee = !l.assignee ? '<span class="muted">Unassigned</span>' : l.assignee === D.me.id ? '<span class="row">' + av(l.assignee, 24) + ' You</span>'
      : (open ? '<span class="muted">Assigned to ' + esc((l.assigneeName || '').split(' ')[0]) + '</span>' : '<span class="row">' + av(l.assignee, 24) + esc(l.assigneeName) + '</span>');
    var status;
    if (l.respondedAt) status = '<span class="green" style="font-weight:500">Responded</span> <span class="ts">in ' + dur(l.respondedAt - l.arrived, true) + '</span>';
    else if (od) status = '<div class="row"><span class="overdue-t breach" data-since="' + l.arrived + '"></span>' + (l.canRespond ? respondBtn(l) : '') + '</div>';
    else if (l.canRespond) status = respondBtn(l);
    else status = '<span class="amber" style="font-weight:500">Pending</span> <span class="ts" data-since="' + l.arrived + '"></span>';
    var pulse = open && (!l.assignee || l.assignee === D.me.id);
    return '<tr class="' + (od ? 'breached' : '') + '" data-go="leads/' + l.id + '">' +
      '<td><div class="lead-cell"><span class="dot-slot">' + (pulse ? '<span class="dot dot6 o pulse-orange"></span>' : '') + '</span><div><div class="nm">' + esc(l.name) + (l.vip ? ' <span class="chip" style="height:18px;font-size:10px;color:var(--status-amber)">VIP</span>' : '') + '</div><div class="mono" style="color:var(--text-muted)">' + l.displayId + '</div></div></div></td>' +
      (hideCampaign ? '' : '<td class="sec">' + esc(l.campaignName || '—') + '</td>') +
      '<td>' + assignee + (canManage() && open ? ' <button class="linkbtn" style="font-size:12px;margin-left:6px" data-act="assignPicker" data-id="' + l.id + '">' + (l.assignee ? 'Reassign' : 'Assign') + '</button>' : '') + '</td>' +
      '<td class="ts" data-ago="' + l.arrived + '"></td>' +
      '<td>' + status + '</td>' +
      '<td><button class="lc-btn tip ' + (l.external ? 'ext' : '') + '" data-tip="View Lifecycle" data-act="lifecycle" data-id="' + l.id + '">' + lifeIcon() + '</button></td></tr>';
  }
  function respondBtn(l) { return '<button class="btn btn-primary btn-sm" data-act="respond" data-id="' + l.id + '">Respond</button>'; }

  // ================================================================ Campaign detail (Screens 3–10)
  function campaignDetail(id, tab) {
    var c = camp(id);
    if (!c) return '<div class="page">' + empty('target', 'Campaign not found.', '', '<a class="btn btn-ghost" href="#/dashboard">Back</a>') + '</div>';
    var tabs = [['overview', 'Overview'], ['leads', 'Leads'], ['pages', 'Pages'], ['insights', 'Insights'], ['forms', 'Forms', 1], ['notes', 'Notes'], ['meeting', 'Meeting Notes'], ['logs', 'Logs'], ['sla', 'SLA']];
    if (c.status === 'COMPLETE' && planOk('watchtower')) tabs.push(['retrospective', 'Retrospective']);
    var head = '<div class="camp-head">' +
      '<div class="crumb"><a href="#/dashboard">' + ic('back', 13) + ' Campaign</a> / ' + esc(user(c.owner).name) + ' <span class="mono" style="color:var(--text-muted);margin-left:8px">camp_' + c.id.slice(0, 8) + '</span></div>' +
      '<div class="spread wrap" style="margin-top:14px"><div class="row gap12 editable"><h1 class="h1" id="campName">' + esc(c.name) + '</h1>' + (canManage() ? '<button class="close pen" data-act="renameCampaign" data-id="' + c.id + '" aria-label="Edit name">' + ic('pen', 14) + '</button>' : '') + '</div>' +
      '<div class="row">' + (planOk('growth') ? (canManage() ? '<button class="btn btn-ghost" data-act="share" data-id="' + c.id + '">' + ic('share', 14) + ' Share with client</button>' : '') : planChip('growth')) +
      (c.status !== 'COMPLETE' && canManage() ? '<button class="btn btn-ghost" data-act="markComplete" data-id="' + c.id + '">Mark Campaign Complete</button>' : '') + '</div></div>' +
      '<div class="camp-meta">' + (c.status === 'COMPLETE' ? '<span class="badge b-blue">Complete</span>' : healthBadge(c.health)) + '<span class="sep"></span>' +
      '<span>Speed-to-lead <b class="' + speedClass(c.avgResp) + '">' + secs(c.avgResp) + '</b></span>' + (c.cpl != null ? '<span class="sep"></span><span>CPL <b class="' + (c.cplThreshold != null && c.cpl > c.cplThreshold ? 'amber' : '') + '">' + money(c.cpl, c.currency) + '</b></span>' : '') +
      '<span class="sep"></span><span>Started ' + fmtDate(c.start) + '</span><span class="sep"></span><span class="row">' + av(c.owner, 20) + esc(user(c.owner).name) + '</span><span class="sep"></span><span>' + (c.end ? 'Completed ' + fmtDate(c.end) : 'Day ' + c.days) + '</span></div>' +
      '<nav class="subtabs">' + tabs.map(function (t) {
        return t[2] ? '<span class="subtab soon">' + t[1] + ' <span class="chip chip-soon">Soon</span></span>' : '<a class="subtab ' + (tab === t[0] ? 'active' : '') + '" href="#/campaigns/' + c.id + '/' + t[0] + '">' + t[1] + (t[0] === 'meeting' ? ' <span class="chip chip-soon">Soon</span>' : '') + '</a>';
      }).join('') + '</nav></div>';
    var body;
    if (tab === 'leads') body = campaignLeads(c);
    else if (tab === 'insights') body = insightsTab(c);
    else if (tab === 'notes') body = '<div style="max-width:760px"><div class="h2">Notes</div><div class="small italic" style="margin-top:4px;color:var(--text-muted)">Notes cannot be deleted. Editable within 2 hours of posting.</div>' + notesBlock('camp:notes:' + c.id, '/campaigns/' + c.id + '/notes', 'campaign', c.id, '/campaigns/' + c.id + '/team-notes') + '</div>';
    else if (tab === 'meeting') body = meetingTab(c);
    else if (tab === 'logs') body = logsTab(c);
    else if (tab === 'retrospective') body = retroTab(c);
    else if (tab === 'pages') body = (canManage() ? '<div class="spread" style="margin-bottom:12px"><div class="h2">Pages</div><button class="btn btn-primary" data-act="upload" data-camp="' + c.id + '">' + ic('upload', 15) + ' Upload page</button></div>' : '') + pagesTable(D.pages.filter(function (p) { return p.camp === c.id; }), true);
    else if (tab === 'sla') body = campaignSla(c);
    else body = overviewTab(c);
    return head + '<div class="page" style="padding-top:28px">' + body + '</div>';
  }

  function campaignLeads(c) {
    var v = lazy('camp:leads:' + c.id, '/campaigns/' + c.id + '/leads?limit=200', function (r) { return { list: r.leads.map(mapLead), more: r.has_more }; });
    if (!v) return skel(5);
    if (v.__error) return errBox(v);
    return leadFilters(false) + '<div id="leadTable" data-camp="' + c.id + '">' + leadTable(filteredLeads(c.id, v.list), true, v.more) + '</div>';
  }

  function overviewTab(c) {
    var budget = '';
    if (c.budget != null && planOk('growth')) {
      var over = c.cpl != null && c.cplThreshold != null && c.cpl > c.cplThreshold;
      budget = '<div class="h3" style="margin-bottom:12px">Budget</div><div class="budget">' +
        '<div><div class="label">Total budget</div><b>' + money(c.budget, c.currency) + '</b></div>' +
        '<div><div class="label">Daily spend</div><b class="row" style="gap:6px">' + money(c.daily, c.currency) + (canManage() && c.status !== 'COMPLETE' ? ' <button class="close" data-act="editSpend" data-id="' + c.id + '" aria-label="Edit daily spend">' + ic('pen', 12) + '</button>' : '') + '</b></div>' +
        '<div><div class="label">Leads to date</div><b>' + c.leads + '</b></div>' +
        '<div><div class="label">CPL (live)</div><b class="' + (over ? 'amber' : 'green') + '">' + money(c.cpl, c.currency) + '</b></div>' +
        '<div><div class="label">CPL threshold</div><b>' + money(c.cplThreshold, c.currency) + '</b><span class="ts">' + (c.cplThreshold == null ? 'Not set' : over ? 'Exceeded' : 'Within range') + '</span></div></div>' +
        (over ? '<div class="banner amber" style="margin-top:12px">' + ic('warn', 15) + ' CPL above your threshold — AI has been notified</div>' : '') +
        (canManage() && c.status !== 'COMPLETE' ? '<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" data-act="logChange" data-id="' + c.id + '">' + ic('clock', 13) + ' Log a campaign change</button><span class="ts" style="margin-left:8px">Feeds campaign memory — Camplo measures the outcome after 7 days.</span></div>' : '') +
        '<div style="height:32px"></div>';
    } else if (c.budget != null) budget = '<div class="card" style="margin-bottom:24px"><div class="spread"><div><div class="h3">Budget tracker & CPL</div><div class="small">Track spend and cost per lead against a threshold.</div></div>' + planChip('growth') + '</div></div>';
    var brief = S.editingOverview ?
      '<div class="editor-bar">' + ['B', 'I', 'U', 'S', 'H', '🔗', '•', '1.', '≡'].map(function (b, i) { var cmds = ['bold', 'italic', 'underline', 'strikeThrough', 'hiliteColor', 'createLink', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft']; return '<button data-cmd="' + cmds[i] + '" title="' + cmds[i] + '">' + b + '</button>'; }).join('') + '</div>' +
      '<div class="editor prose" contenteditable="true" id="ovEditor">' + (c.brief || '') + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="saveOverview" data-id="' + c.id + '">Save</button><button class="btn btn-ghost" data-act="cancelOverview">Cancel</button></div>'
      : '<div class="editable"><div class="spread"><div class="h3">Campaign brief</div>' + (canManage() ? '<button class="btn btn-ghost btn-sm pen" data-act="editOverview">' + ic('pen', 13) + ' Edit</button>' : '') + '</div>' +
      '<div class="prose" style="margin-top:12px">' + (c.brief ? sanitize(c.brief) : '<p class="muted">No brief yet.</p>') + '</div></div>';
    var ins = sortInsights(D.insights.filter(function (i) { return i.camp === c.id; })).slice(0, 2);
    return '<div class="dossier"><div>' + budget + brief + '</div><aside class="rail">' +
      '<div class="glass" style="padding:20px"><div class="row" style="margin-bottom:12px"><div class="brain-ico" style="width:28px;height:28px">' + ic('brain', 14) + '</div><div class="h3">Latest intelligence</div></div><div class="feed" style="margin-top:0">' +
      (ins.length ? ins.map(function (i, x) { return insightCard(i, x, { noActions: true }); }).join('') : '<div class="small">No insights yet for this campaign.</div>') + '</div>' +
      '<a class="linkbtn" style="display:inline-block;margin-top:12px" href="#/campaigns/' + c.id + '/insights">All insights →</a></div>' +
      '<div class="card"><div class="label">Health signals</div>' + (c.signals ? ['lead_volume', 'acknowledgment', 'webhook'].map(function (k) {
        var s = c.signals[k]; return '<div class="spread small" style="margin-top:10px"><span>' + { lead_volume: 'Lead volume (7d vs 4-wk avg)', acknowledgment: 'Acknowledgment rate', webhook: 'Webhook health' }[k] + '</span><span class="dot ' + { green: 'g', amber: 'a', red: 'r' }[s] + '"></span></div>';
      }).join('') : '<div style="margin-top:8px">' + planChip('growth') + '</div>') + '</div>' +
      '<div class="card"><div class="label">Leads</div><div class="spread small" style="margin-top:10px"><span>Received</span><b style="color:var(--text-primary)">' + c.leads + '</b></div><div class="spread small" style="margin-top:6px"><span>Responded</span><b class="green">' + c.responded + '</b></div><div class="spread small" style="margin-top:6px"><span>Not responded</span><b class="red">' + (c.leads - c.responded) + '</b></div></div></aside></div>';
  }
  /** Only allow simple formatting tags from the rich-text brief. */
  function sanitize(html) {
    var d = document.createElement('div'); d.innerHTML = html;
    var ok = { P: 1, B: 1, STRONG: 1, I: 1, EM: 1, U: 1, S: 1, STRIKE: 1, UL: 1, OL: 1, LI: 1, BR: 1, A: 1, SPAN: 1, DIV: 1, MARK: 1 };
    (function walk(n) {
      Array.prototype.slice.call(n.children).forEach(function (el) {
        if (!ok[el.tagName]) { el.replaceWith(document.createTextNode(el.textContent)); return; }
        Array.prototype.slice.call(el.attributes).forEach(function (a) {
          if (el.tagName === 'A' && a.name === 'href' && /^(https?:|#\/)/.test(a.value)) return;
          if (a.name === 'style' && /^background-color:[^;]+;?$/.test(a.value.replace(/\s/g, ''))) return;
          el.removeAttribute(a.name);
        });
        if (el.tagName === 'A') { el.setAttribute('rel', 'noopener noreferrer'); el.setAttribute('target', '_blank'); }
        walk(el);
      });
    })(d);
    return d.innerHTML;
  }

  function insightsTab(c) {
    if (!planOk('growth')) {
      return '<div style="max-width:760px"><div class="h2">Insights</div><div class="card" style="margin-top:16px"><div class="spread"><div class="small">Campaign intelligence feeds are available on Growth.</div>' + planChip('growth') + '</div></div></div>';
    }
    var cats = ['All', 'SLA', 'Spend', 'Performance', 'Engagement'];
    var recsV = lazy('camp:recs:' + c.id, '/campaigns/' + c.id + '/recommendations');
    var list = D.insights.filter(function (i) { return i.camp === c.id && (S.insightFilter === 'All' || i.cat === S.insightFilter); });
    var recs = recsV && !recsV.__error ? recsV : [];
    var head = '<div class="spread wrap"><div><div class="h2">Insights</div><div class="italic small" style="color:var(--text-muted)">Powered by Camplo Intelligence</div></div><button class="btn btn-ghost btn-sm" data-act="refreshInsights">' + ic('refresh', 14) + ' Refresh</button></div>';
    if (!list.length && !recs.length && S.insightFilter === 'All') return '<div style="max-width:760px">' + head + (recsV ? empty('brain', 'No insights yet.', 'Camplo will surface intelligence as your campaign generates activity.') : skel(3)) + '</div>';
    var pri = list.filter(function (i) { return i.priority; });
    var mon = list.filter(function (i) { return i.kind === 'insufficient_evidence'; });
    var rest = list.filter(function (i) { return !i.priority && i.kind !== 'insufficient_evidence'; });
    var groups = {}, order = [];
    sortInsights(rest).forEach(function (i) { var k = dayLabel(i.t); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); });
    return '<div style="max-width:760px">' + head +
      '<div class="pills" style="margin:20px 0">' + cats.map(function (k) { return '<button class="pill ' + (S.insightFilter === k ? 'active' : '') + '" data-act="ifilter" data-v="' + k + '">' + k + '</button>'; }).join('') + '</div>' +
      '<div class="feed">' + pri.map(function (i, x) { return insightCard(i, x); }).join('') + '</div>' +
      order.map(function (k) { return '<div class="daygroup"><div class="section-label"><span class="label">' + k + '</span></div><div class="feed" style="margin-top:0">' + groups[k].map(function (i, x) { return insightCard(i, x); }).join('') + '</div></div>'; }).join('') +
      (recs.length ? '<div class="section-label"><span class="label">Recommendations</span></div><div class="feed" style="margin-top:0">' + recs.map(function (r, i) { return recCard(r, i); }).join('') + '</div>' : '') +
      (mon.length ? '<div class="section-label"><span class="label">Monitoring</span></div><div class="feed" style="margin-top:0">' + mon.map(monitoringCard).join('') + '</div>' : '') + '</div>';
  }

  function notesBlock(key, path, type, entityId, teamPath) {
    var v = lazy(key, path);
    var tn = teamPath && planOk('growth') ? lazy(key + ':team', teamPath) : [];
    if (!v) return skel(2);
    if (v.__error) return errBox(v);
    var list = v.map(function (n) { return Object.assign({ kind: 'note' }, n); });
    (tn && !tn.__error ? tn : []).forEach(function (t) { list.push({ kind: 'team', id: t.id, authorId: t.authorId, authorName: t.authorName, content: t.content, createdAt: t.createdAt, editedAt: t.editedAt, recipients: t.recipients }); });
    list.sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); });
    var items = list.length ? list.map(noteItem).join('') : empty('note', 'No notes yet. Be the first to add one.', '');
    return '<div style="margin-top:12px">' + items + '</div>' +
      '<div class="note-compose"><textarea class="input" rows="2" id="noteInput" placeholder="Add a note... Notes cannot be deleted once posted."></textarea>' +
      '<div class="spread"><span class="ts">⌘/Ctrl + Enter to post</span><button class="btn btn-primary" id="postNote" data-act="postNote" data-type="' + type + '" data-entity="' + entityId + '" data-key="' + key + '" disabled>Post Note</button></div></div>';
  }
  function noteItem(n) {
    var who = av(n.authorId);
    if (S.editNote === n.id) {
      return '<div class="note">' + who + '<div class="grow"><div class="who">' + esc(n.authorName) + '</div><textarea class="input" id="editNoteInput" style="margin-top:8px">' + esc(n.content) + '</textarea><div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="saveNote" data-id="' + n.id + '" data-team="' + (n.kind === 'team' ? 1 : 0) + '">Save</button><button class="btn btn-ghost btn-sm" data-act="cancelNote">Cancel</button></div></div></div>';
    }
    var meeting = n.type === 'meeting';
    return '<div class="note ' + (meeting || n.kind === 'team' ? 'ext' : '') + '">' + who + '<div class="grow">' +
      '<div class="row wrap"><span class="who">' + esc(n.authorName) + '</span>' + (meeting ? '<span class="chip chip-blue">Via ' + esc(n.via || 'Manual') + '</span>' : '') +
      (n.kind === 'team' ? '<span class="chip chip-blue">Team Note → ' + n.recipients.map(function (r) { return '@' + esc(r.name.split(' ')[0]); }).join(' ') + '</span>' : '') +
      '<span class="ts" data-ago="' + ms(n.createdAt) + '"></span>' + (n.editable ? '<button class="edit-pen" data-act="editNote" data-id="' + n.id + '" aria-label="Edit note">' + ic('pen', 13) + '</button>' : '') + '</div>' +
      (meeting && n.title ? '<div style="font-weight:600;margin-top:4px">' + esc(n.title) + (n.meetingDate ? ' <span class="ts">· ' + fmtDate(n.meetingDate) + '</span>' : '') + '</div>' : '') +
      (n.editedAt ? '<div class="edited">Edited · ' + new Date(n.editedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</div>' : '') +
      (n.editable ? '<div class="editable-for" data-until="' + ms(n.editableUntil) + '" data-prefix="Editable for "></div>' : '') +
      '<div class="body">' + esc(n.content) + '</div></div></div>';
  }

  function meetingTab(c) {
    var v = lazy('camp:meeting:' + c.id, '/campaigns/' + c.id + '/meeting-notes');
    if (!v) return skel(2);
    if (v.__error) return errBox(v);
    return '<div style="max-width:760px"><div class="spread"><div><div class="h2">Meeting Notes</div><div class="small italic" style="color:var(--text-muted)">Meeting notes will appear here automatically when you connect a meeting tool (coming soon). Add them manually for now.</div></div></div>' +
      '<div style="margin-top:12px">' + (v.length ? v.map(function (n) { return noteItem(Object.assign({ kind: 'note' }, n)); }).join('') : empty('note', 'No meeting notes yet.', '')) + '</div>' +
      '<div class="card" style="margin-top:16px"><div class="h3">Add manually</div><div class="form-grid" style="margin-top:12px"><div class="field"><label>Title (optional)</label><input class="input" id="mnTitle" /></div><div class="field"><label>Meeting date</label><input class="input" type="datetime-local" id="mnDate" /></div></div>' +
      '<textarea class="input" id="mnBody" style="margin-top:12px" placeholder="What was agreed? Notes cannot be deleted once posted."></textarea><div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" data-act="postMeeting" data-id="' + c.id + '">Save</button></div></div></div>';
  }

  function logsTab(c) {
    if (!planOk('growth')) return '<div class="card"><div class="spread"><div class="small">Campaign activity logs are available on Growth.</div>' + planChip('growth') + '</div></div>';
    var range = S.logRange || {};
    var key = 'camp:logs:' + c.id + ':' + (range.from || '') + ':' + (range.to || '');
    var v = lazy(key, '/campaigns/' + c.id + '/logs' + (range.from ? '?from=' + range.from + (range.to ? '&to=' + range.to : '') : ''));
    var head = '<div class="spread wrap"><div class="h2">Activity Log</div><div class="row"><input class="input" type="date" id="logFrom" value="' + (range.from || '') + '" style="width:160px"><span class="ts">to</span><input class="input" type="date" id="logTo" value="' + (range.to || '') + '" style="width:160px"><button class="btn btn-ghost btn-sm" data-act="logRange" data-id="' + c.id + '">Apply</button>' + (range.from ? '<button class="linkbtn" data-act="logClear">Clear</button>' : '') + '</div></div>';
    if (!v) return head + skel(4);
    if (v.__error) return head + errBox(v);
    if (!v.logs.length) return head + empty('clock', range.from ? 'No activity in this period.' : 'No activity recorded yet.', range.from ? '' : 'Events will appear as your team works.');
    var groups = {}, order = [];
    v.logs.forEach(function (e) { var k = dayLabel(ms(e.createdAt)); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(e); });
    return '<div style="max-width:860px">' + head + order.map(function (k) {
      return '<div class="section-label"><span class="label">' + k + '</span></div>' + groups[k].map(function (e) {
        return '<div class="log"><span class="mono">' + clock(ms(e.createdAt)) + '</span>' + (e.actorId ? av(e.actorId, 24) : '<span class="avatar s24" style="color:var(--accent-blue)">' + ic('brain', 12) + '</span>') + '<span>' + esc(e.description) + '</span></div>';
      }).join('');
    }).join('') + '</div>';
  }

  function retroTab(c) {
    var st = lazy('camp:retro:' + c.id, '/campaigns/' + c.id + '/retrospective');
    if (!st) return skel(4);
    if (st.__error) return errBox(st);
    if (!st.generated) {
      setTimeout(function () { if (route().parts[2] === 'retrospective') { inval('camp:retro:' + c.id); render(true); } }, 3000);
      return '<div class="card"><div class="row gap12"><div class="brain-ico think">' + ic('brain', 18) + '</div><div><div class="h3">Generating your retrospective…</div><div class="small">This usually takes a few seconds.</div></div></div>' + skel(3) + '</div>';
    }
    var r = st;
    return '<div style="max-width:960px"><div class="spread wrap"><div><h1 class="h1">Campaign Retrospective</h1><div class="small italic" style="color:var(--text-muted);margin-top:4px">Generated automatically when campaign was marked complete</div></div>' +
      '<a class="btn btn-primary" href="/api/campaigns/' + c.id + '/retrospective/pdf" download>' + ic('download', 15) + ' Download PDF</a></div>' +
      '<div class="glass" style="padding:32px;margin-top:24px;cursor:default">' +
      '<div class="spread"><div><div class="h2">' + esc(r.campaignName) + '</div><div class="small">' + fmtDate(r.startDate) + ' – ' + fmtDate(r.endDate) + ' · ' + r.daysActive + ' days active</div></div><span class="badge b-blue">Complete</span></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(' + (r.cpl != null ? 4 : 3) + ',1fr);margin:28px 0 0">' +
      '<div><div class="label">Total leads</div><div class="display">' + (r.totalLeads || 0) + '</div></div>' +
      '<div><div class="label">Avg speed-to-lead</div><div class="display ' + speedClass(r.avgResponseTimeMs == null ? null : r.avgResponseTimeMs / 1000) + '" style="font-size:40px">' + dur(r.avgResponseTimeMs, true) + '</div><div class="kpi-sub">5 min target · you averaged ' + dur(r.avgResponseTimeMs, true) + '</div></div>' +
      '<div><div class="label">Acknowledgment rate</div><div class="display">' + (r.acknowledgmentRate == null ? '—' : Math.round(r.acknowledgmentRate * 100) + '%') + '</div></div>' +
      (r.cpl != null ? '<div><div class="label">Cost per lead</div><div class="display" style="font-size:40px">' + money(r.cpl, r.currency) + '</div></div>' : '') + '</div>' +
      (r.bestPage || r.worstPage ? '<div class="divider" style="margin:28px 0"></div><div class="form-grid">' +
        (r.bestPage ? '<div><div class="label">Best performing page</div><div class="h3" style="margin-top:6px">' + esc(r.bestPage.name) + '</div><div class="green small">' + (r.bestPage.conversionRate == null ? '' : (r.bestPage.conversionRate * 100).toFixed(1) + '% conversion') + '</div></div>' : '') +
        (r.worstPage ? '<div><div class="label">Worst performing page</div><div class="h3" style="margin-top:6px">' + esc(r.worstPage.name) + '</div><div class="red small">' + (r.worstPage.conversionRate == null ? '' : (r.worstPage.conversionRate * 100).toFixed(1) + '% conversion') + '</div></div>' : '') + '</div>' : '') +
      '<div class="divider" style="margin:28px 0"></div><div class="label">AI observation</div>' +
      '<p style="font:italic 500 16px/1.7 var(--f-display);color:var(--text-secondary);margin:12px 0 0">' + esc(r.aiObservation) + '</p>' +
      '<div class="ts" style="margin-top:28px;text-align:center">Powered by Camplo</div></div></div>';
  }

  function campaignSla(c) {
    var s = lazy('camp:sla:' + c.id, '/campaigns/' + c.id + '/sla');
    var od = lazy('camp:od:' + c.id, '/sla/overdue?campaignId=' + c.id);
    var tr = lazy('camp:trend:' + c.id, '/campaigns/' + c.id + '/sla/trend');
    var tm = lazy('camp:team:' + c.id, '/campaigns/' + c.id + '/sla/team');
    if (!s || !od || !tr || !tm) return skel(4);
    if (s.__error) return errBox(s);
    var sec = s.avgResponseMs == null ? null : Math.round(s.avgResponseMs / 1000);
    return '<div class="sla-grid"><div class="card"><div class="label">Campaign SLA summary</div><div class="display ' + speedClass(sec) + '" style="margin-top:8px">' + secs(sec) + '</div><div class="small" style="margin-top:8px">Threshold ' + s.thresholdMinutes + 'm · ' + s.respondedCount + ' of ' + s.leadCount + ' responded</div>' +
      '<div class="label" style="margin-top:20px">7-day trend</div>' + trendBars(tr.days, null) + '</div>' +
      '<div class="col gap24"><div class="card"><div class="spread"><div class="label">Overdue now</div><span class="badge b-red">' + od.count + '</span></div>' + (od.count ? od.leads.map(overdueRow).join('') : okEmpty()) + '</div>' +
      '<div class="card"><div class="label">Team performance</div>' + tm.map(function (m) { return '<div class="list-row">' + av(m.id, 24) + '<span class="grow">' + esc(m.name) + '</span><span style="width:110px">' + secs(m.avgThisWeekMs == null ? null : m.avgThisWeekMs / 1000) + '</span><span style="width:90px" class="' + (m.breachesThisWeek ? 'red' : 'green') + '">' + m.breachesThisWeek + ' breaches</span></div>'; }).join('') + '</div></div></div>' +
      '<div style="margin-top:16px"><a href="#/sla?tab=config">Configure SLA settings →</a></div>';
  }
  function okEmpty() { return '<div class="empty" style="padding:24px"><div class="check-big">' + ic('check', 28) + '</div><div class="h">No overdue leads right now.</div></div>'; }

  // ================================================================ Lead Dossier (Screen 5)
  function dossier(leadId) {
    var l = lazy('lead:' + leadId, '/leads/' + leadId, mapLead);
    if (!l) return '<div class="page">' + skel(6) + '</div>';
    if (l.__error) return '<div class="page">' + empty('inbox', 'Lead not found.', '', '<a class="btn btn-ghost" href="#/leads">Back to Lead Inbox</a>') + '</div>';
    var c = camp(l.campaign);
    var thr = l.thr * 60;
    var breaching = !l.respondedAt && isOverdue(l);
    var anchor = l.assignedAt;
    var head = '<a class="crumb" href="#/leads">' + ic('back', 13) + ' Back to Lead Inbox</a>' +
      '<div class="spread wrap" style="margin-top:16px"><h1 class="h1">Lead Dossier</h1>' +
      (l.respondedAt ? '<span class="badge b-green xl">Responded</span>' : l.canRespond ? '<button class="btn btn-primary" data-act="respond" data-id="' + l.id + '" data-big="1">' + ic('check', 15) + ' Mark as Responded</button>' : '<span class="small">Assigned to ' + esc(l.assigneeName) + '</span>') + '</div>' +
      (l.respondedAt ? '<div class="small" style="margin-top:8px">Responded by ' + esc(l.respondedByName) + ' at ' + new Date(l.respondedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</div>' : '<div style="margin-top:12px"><span class="badge b-red xl b-bold">Not responded</span></div>') +
      '<div class="dossier-name">' + esc(l.name) + (l.vip ? ' <span class="chip" style="vertical-align:middle;color:var(--status-amber)">VIP</span>' : '') + '</div>' +
      '<div class="sec">' + esc(l.email || '—') + ' · ' + esc(l.phone || '—') + '</div>' +
      '<div class="sla-card ' + (breaching ? 'breaching' : '') + '">' +
      '<div><div class="label">Customer waiting</div><div class="timer big" data-since="' + l.arrived + '" data-stop="' + (l.respondedAt || '') + '" data-thr="' + thr + '"></div><div class="ts">Since arrival · ' + clock(l.arrived) + ' · threshold ' + l.thr + 'm</div></div>' +
      '<div class="vr"></div>' +
      '<div><div class="label">Response time <span style="text-transform:none;letter-spacing:0;font-size:11px">· ' + (l.path === 'A' ? 'from claim' : l.path ? 'from assignment' : 'not yet claimed') + '</span></div>' +
      (anchor ? '<div class="timer big" data-since="' + anchor + '" data-stop="' + (l.respondedAt || '') + '" data-thr="' + thr + '"></div>' : '<div class="timer big muted">—</div>') +
      '<div class="ts">' + (l.respondedAt ? 'Stopped at ' + clock(l.respondedAt) : l.assignee ? 'Owned by ' + esc(l.assigneeName) : 'Open to all team members') + '</div></div></div>';

    var u = l.utm;
    var attr = '<section class="dsec"><div class="h2">Attribution</div><dl class="kv">' +
      '<dt>Source Page</dt><dd>' + (l.page ? (l.deploymentDeleted ? esc(l.page) + ' <span class="chip">Page deleted</span>' : '<a href="#/pages">' + esc(l.page) + '</a>') : '—') + '</dd>' +
      '<dt>Campaign</dt><dd>' + (c ? '<a href="#/campaigns/' + c.id + '/overview">' + esc(c.name) + '</a>' : '—') + '</dd>' +
      '<dt>Source System</dt><dd>' + esc(l.source) + '</dd>' +
      '<dt>Source Identifier</dt><dd class="mono">' + esc(l.sourceId || '—') + '</dd>' +
      '<dt>Received At</dt><dd>' + new Date(l.arrived).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</dd>' +
      (u ? ['source', 'medium', 'campaign', 'content', 'term'].filter(function (k) { return u[k]; }).map(function (k) { return '<dt>UTM ' + cap(k) + '</dt><dd class="mono">' + esc(u[k]) + '</dd>'; }).join('') : '') +
      '</dl>' + (l.utmLocked ? '<div class="row" style="margin-top:12px"><span class="small">UTM capture and attribution</span>' + planChip('growth') + '</div>' : u ? '' : '<div class="small muted" style="margin-top:12px;color:var(--text-muted)">No UTM data captured for this lead.</div>') + '</section>';

    var au = lazy('lead:audit:' + l.id, '/leads/' + l.id + '/audit');
    var audit = '<section class="dsec"><div class="h2">Audit Trail <span style="margin-left:auto">' + (l.respondedAt ? '<span class="badge b-green">Responded</span>' : '<span class="badge b-red">Not responded</span>') + '</span></div>' +
      (!au ? skel(2) : au.__error ? errBox(au) : '<ul class="audit">' + au.events.map(function (e) { return '<li><span class="mono">' + clock(ms(e.at)) + '</span><span class="row">' + (e.actorId ? av(e.actorId, 20) : '') + esc(e.description) + '</span><span class="ts">' + esc(e.actorName) + '</span></li>'; }).join('') + '</ul>') + '</section>';

    var lc = lazy('lead:life:' + l.id, '/leads/' + l.id + '/lifecycle');
    var lcHtml = '<section class="dsec"><div class="h2">Lifecycle</div>' + (!lc ? skel(2) : lc.__error ? errBox(lc) : timeline(lc) +
      (lc.some(function (e) { return e.source !== 'camplo'; }) ? '' : '<div class="small" style="margin-top:12px">No external lifecycle events yet. Connect a CRM via webhook to see the full lead journey. <a href="#/settings/integrations">Connect</a></div>')) + '</section>';

    var notes = '<section class="dsec"><div class="h2">Notes</div>' + notesBlock('lead:notes:' + l.id, '/leads/' + l.id + '/notes', 'lead', l.id, '/leads/' + l.id + '/team-notes') + '</section>';

    var rail = '<aside class="rail">' +
      '<div class="glass" style="padding:20px"><div class="row" style="margin-bottom:10px"><div class="brain-ico" style="width:28px;height:28px">' + ic('brain', 14) + '</div><div class="h3">What Camplo sees</div></div>' +
      '<div class="small" style="line-height:1.6">' + (l.respondedAt ? 'Responded in <b>' + dur(l.respondedAt - l.arrived, true) + '</b>' + (l.respondedAt - l.arrived < 5 * MIN ? ' — inside the 5-minute window where contact rates are highest.' : '. Answers inside five minutes are far more likely to reach a conversation.') :
        'Every minute past 5 lowers the chance of contact. ' + (breaching ? '<b class="red">This lead is past your ' + l.thr + '-minute threshold.</b> ' : '') + (l.vip ? 'This is a <b>VIP page</b> lead.' : '')) + '</div></div>' +
      (c ? '<div class="card"><div class="label">Campaign</div><a class="h3" style="display:block;margin-top:6px;color:var(--text-primary)" href="#/campaigns/' + c.id + '/overview">' + esc(c.name) + '</a><div style="margin-top:8px">' + (c.status === 'COMPLETE' ? '<span class="badge b-blue">Complete</span>' : healthBadge(c.health)) + '</div></div>' : '') +
      (canManage() && !l.respondedAt && (isOwner() || !l.assignee) ? '<div class="card"><div class="label" style="margin-bottom:8px">' + (l.assignee ? 'Reassign (owner)' : 'Assign') + '</div><select class="select" data-act-change="reassign" data-id="' + l.id + '"><option value="">Choose team member…</option>' +
        D.team.filter(function (t) { return t.id !== l.assignee; }).map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') + '</select><div class="ts" style="margin-top:8px">Response timer resets for the new assignee. Customer-waiting timer never resets.</div></div>' : '') +
      '</aside>';
    return '<div class="page"><div class="dossier"><div>' + head + attr + audit + lcHtml + notes + '</div>' + rail + '</div></div>';
  }
  var SRC = { camplo: 'Camplo', twenty_crm: 'Twenty CRM', gohighlevel: 'GoHighLevel', hubspot: 'HubSpot', salesforce: 'Salesforce', activecampaign: 'ActiveCampaign', brevo: 'Brevo', mailchimp: 'Mailchimp' };
  function timeline(events) {
    if (!events.length) return '<div class="small">No lifecycle events recorded yet.</div>';
    return '<ul class="timeline">' + events.map(function (e) {
      var t = ms(e.at), label = Date.now() - t > DAY ? new Date(t).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) : clock(t);
      var dot = e.isMilestone ? 'm' : e.source === 'camplo' ? 'c' : 'e';
      return '<li class="' + (e.isMilestone && /won/i.test(e.event) ? 'ms' : '') + '"><span class="t">' + label + '</span><span class="tdot ' + dot + '"></span><span class="ev" style="' + (e.isMilestone ? 'font-weight:700' : '') + '">' + esc(e.event) + '</span><span class="src">' + esc(SRC[e.source] || e.source) + '</span></li>';
    }).join('') + '</ul>';
  }

  // ================================================================ Pages (Screen 11)
  function hookIndicator(p) {
    var m = { healthy: ['g', '', 'Live · Last ping <span data-ago="' + p.ping + '"></span>'], warning: ['a', 'pulse-slow', 'Quiet · last ping <span data-ago="' + p.ping + '"></span>'], offline: ['r', 'pulse-fast', 'Offline · Last ping <span data-ago="' + p.ping + '"></span>'], never: ['m', '', 'Not connected'] }[p.hook];
    return '<span class="row" style="gap:8px"><span class="dot ' + m[0] + ' ' + m[1] + '"></span><span style="font-size:12px;color:var(--text-secondary)">' + m[2] + '</span></span>';
  }
  function pagesTable(list, hideCampaign) {
    if (!list.length) return empty('file', 'No pages hosted yet.', 'Upload your first campaign page to get started.', canManage() ? '<button class="btn btn-primary" data-act="upload">Upload Page</button>' : '');
    return list.filter(function (p) { return p.watch72; }).map(function (p) { return '<div class="banner amber" style="margin-bottom:12px"><span class="chip" style="color:var(--status-amber)">72h Watch</span><b>' + esc(p.name) + '</b> — conversion dropped during the early monitoring window. Review page and traffic quality before spending more budget.</div>'; }).join('') +
      '<div class="table-wrap"><table><thead><tr><th>Page name</th>' + (hideCampaign ? '' : '<th>Campaign</th>') + '<th>Status</th><th>Webhook</th><th>Visits (7d)</th><th>Leads (7d)</th><th>Conversion</th>' + (canManage() ? '<th style="text-align:right">Actions</th>' : '') + '</tr></thead><tbody>' +
      list.map(function (p) {
        var st = { ACTIVE: 'b-green', PAUSED: 'b-amber', ARCHIVED: 'b-grey' }[p.status];
        return '<tr data-act="pageDrawer" data-id="' + p.id + '"><td><div class="nm" style="font-weight:600">' + esc(p.name) + (p.vip ? ' <span class="chip" style="height:18px;font-size:10px;color:var(--status-amber)">VIP</span>' : '') + '</div><div class="mono" style="color:var(--text-muted)">' + esc(p.host) + '</div></td>' +
          (hideCampaign ? '' : '<td class="sec">' + esc(p.campName || '—') + '</td>') + '<td><span class="badge ' + st + '">' + p.status + '</span></td><td>' + hookIndicator(p) + '</td><td>' + p.visits.toLocaleString() + '</td><td>' + p.leads + '</td>' +
          '<td class="' + (p.conv == null ? 'muted' : p.above ? 'green' : 'red') + '" style="font-weight:600">' + (p.conv == null ? '—' : (p.conv * 100).toFixed(1) + '%') + '</td>' +
          (canManage() ? '<td style="text-align:right"><div class="row" style="justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-act="redeploy" data-id="' + p.id + '" title="Upload new version">' + ic('upload', 13) + '</button><button class="btn btn-ghost btn-sm" data-act="serving" data-id="' + p.id + '" data-v="' + (p.status === 'ACTIVE' ? 'pause' : 'unpause') + '">' + (p.status === 'ACTIVE' ? 'Pause' : 'Unpause') + '</button><button class="btn btn-ghost btn-sm" data-act="pageMenu" data-id="' + p.id + '">' + ic('more', 14) + '</button></div></td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div>';
  }
  function pagesScreen() {
    var active = D.pages.filter(function (p) { return p.status === 'ACTIVE'; }).length;
    var q = (S.pageQuery || '').toLowerCase(), st = S.pageStatus || 'all', cf = S.pageCamp || 'all';
    var list = D.pages.filter(function (p) { return (!q || p.name.toLowerCase().indexOf(q) >= 0) && (st === 'all' || p.status === st) && (cf === 'all' || p.camp === cf); });
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Pages</h1><div class="small" style="margin-top:6px">' + D.pages.length + ' pages hosted · ' + active + ' active' + (D.accAvg != null ? ' · account avg conversion ' + (D.accAvg * 100).toFixed(1) + '%' : '') + '</div></div>' +
      (canManage() ? '<button class="btn btn-primary" data-act="upload">' + ic('upload', 15) + ' Upload a new page</button>' : '') + '</div>' +
      '<div class="filters"><input class="input" id="pageSearch" placeholder="Search pages" value="' + esc(S.pageQuery || '') + '" style="width:240px;height:36px" />' +
      '<select class="select" data-pfilter="pageStatus"><option value="all">All statuses</option>' + ['ACTIVE', 'PAUSED', 'ARCHIVED'].map(function (x) { return '<option value="' + x + '"' + (st === x ? ' selected' : '') + '>' + cap(x.toLowerCase()) + '</option>'; }).join('') + '</select>' +
      '<select class="select" data-pfilter="pageCamp"><option value="all">All campaigns</option>' + D.campaigns.map(function (c) { return '<option value="' + c.id + '"' + (cf === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      pagesTable(list) + '</div>';
  }
  function pageDrawer(id) {
    var p = byId(D.pages, id);
    var a = lazy('page:analytics:' + id, '/pages/' + id + '/analytics');
    var ls = lazy('page:leads:' + id, '/leads?deployment_id=' + id + '&limit=20', function (r) { return r.leads.map(mapLead); });
    var max = a && !a.__error ? Math.max.apply(null, a.daily.map(function (d) { return d.visits; }).concat([1])) : 1;
    return drawer('w520', '<div><div class="h2">' + esc(p.name) + '</div><div class="row wrap" style="margin-top:6px"><span class="badge ' + ({ ACTIVE: 'b-green', PAUSED: 'b-amber', ARCHIVED: 'b-grey' }[p.status]) + '">' + p.status + '</span><span class="mono">' + esc(p.host) + '</span><a href="' + esc(p.url) + '" target="_blank" rel="noopener">Open page ↗</a></div></div>',
      '<div class="label">Traffic · 7 days</div>' + (a && !a.__error ? '<div class="bars" style="height:120px">' + a.daily.map(function (d) { return '<div class="bar" title="' + d.visits + ' visits · ' + d.leads + ' leads"><i style="height:' + Math.max(2, Math.round(d.visits / max * 100)) + '%;background:var(--accent-blue)"></i><span>' + new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'narrow', timeZone: 'UTC' }) + '</span></div>'; }).join('') + '</div>' : skel(1)) +
      '<div class="card" style="margin-top:24px"><div class="spread"><div><div class="label">Webhook health</div><div style="margin-top:8px">' + hookIndicator(p) + '</div></div><button class="btn btn-ghost btn-sm" data-act="testHook" data-id="' + p.id + '">Test Webhook</button></div>' +
      '<div class="label" style="margin-top:14px">Webhook URL</div><div class="row"><span class="mono grow" style="word-break:break-all">' + esc(p.webhookUrl) + '</span><button class="close" data-act="copy" data-v="' + esc(p.webhookUrl) + '">' + ic('copy', 14) + '</button></div>' +
      (p.secret ? '<div class="label" style="margin-top:10px">Signing secret (HMAC-SHA256 → X-Camplo-Signature: sha256=…)</div><div class="input-wrap"><input class="input mono" type="password" readonly value="' + esc(p.secret) + '" id="pgsecret" style="font-size:12px"/><span class="acts"><button data-act="eye" data-for="pgsecret">' + ic('eye', 14) + '</button><button data-act="copy" data-v="' + esc(p.secret) + '">' + ic('copy', 14) + '</button></span></div>' : '') + '</div>' +
      '<div class="label" style="margin:24px 0 8px">Leads from this page</div>' + (!ls ? skel(2) : ls.__error ? errBox(ls) : ls.length ? ls.map(function (l) { return '<div class="list-row" data-go="leads/' + l.id + '" style="cursor:pointer"><span class="grow"><b>' + esc(l.name) + '</b> <span class="mono" style="color:var(--text-muted)">' + l.displayId + '</span></span>' + (l.respondedAt ? '<span class="green">Responded</span>' : '<span class="red" data-since="' + l.arrived + '"></span>') + '</div>'; }).join('') : '<div class="small">No leads from this page yet.</div>') +
      (canManage() ? '<div class="col gap12" style="margin-top:24px">' + (p.rollback ? '<div><button class="btn btn-ghost" data-act="rollback" data-id="' + p.id + '">Rollback to previous version</button><div class="ts" style="margin-top:4px">Version from ' + fmtDate(p.prevAt) + ' · stored for 30 days</div></div>' : '') +
        '<button class="btn btn-ghost" style="align-self:flex-start" data-act="domain" data-id="' + p.id + '">' + (p.domain ? 'Custom domain: ' + esc(p.domain.name) + ' (' + p.domain.status + ')' : 'Connect custom domain') + '</button>' +
        '<label class="checkbox"><input type="checkbox" data-act-change="pageVip" data-id="' + p.id + '" ' + (p.vip ? 'checked' : '') + '/> VIP page (tighter SLA threshold)</label></div>' : ''));
  }

  // ================================================================ SLA (Screen 12)
  function overdueRow(l) {
    return '<div class="list-row"><div class="grow"><a href="#/leads/' + l.id + '" style="color:var(--text-primary);font-weight:600">' + esc(l.name) + '</a>' + (l.vip ? ' <span class="chip" style="height:18px;font-size:10px;color:var(--status-amber)">VIP</span>' : '') + '<div class="ts">' + esc(l.pageName || 'webhook') + ' · ' + esc(l.campaignName || '—') + '</div></div><span class="overdue-t breach" style="font-size:15px" data-since="' + ms(l.receivedAt) + '"></span><span class="row" style="width:140px">' + (l.assigneeId ? av(l.assigneeId, 24) + esc((l.assigneeName || '').split(' ')[0]) : '<span class="muted">Unassigned</span>') + '</span>' + (canManage() ? '<button class="btn btn-primary btn-sm" data-act="notify" data-id="' + l.id + '">Notify Now</button>' : '') + '</div>';
  }
  function slaScreen() {
    var tabs = '<nav class="settings-tabs"><button class="subtab ' + (S.slaTab === 'live' ? 'active' : '') + '" data-act="slaTab" data-v="live">Live Status</button>' + (canManage() ? '<button class="subtab ' + (S.slaTab === 'config' ? 'active' : '') + '" data-act="slaTab" data-v="config">Configuration</button>' : '') + '</nav>';
    var head = '<div class="page-head"><div><h1 class="h1">SLA</h1><div class="watching">' + ic('brain', 14) + ' Monitoring every handoff from page visit to closed deal</div></div></div>';
    return '<div class="page">' + head + tabs + (S.slaTab === 'config' && canManage() ? slaConfig() : slaLive()) + '</div>';
  }
  function trendBars(days, sel) {
    var colors = { green: 'var(--status-green)', amber: 'var(--status-amber)', red: 'var(--status-red)', none: 'var(--border-default)' };
    var max = Math.max.apply(null, days.map(function (d) { return d.avgMs || 0; }).concat([1]));
    return '<div class="bars">' + days.map(function (d, i) { return '<div class="bar ' + (sel === i ? 'sel' : '') + '" data-act="slaDay" data-v="' + i + '" title="' + d.leads + ' leads"><i style="height:' + (d.avgMs == null ? 4 : Math.max(8, Math.round(d.avgMs / max * 100))) + '%;background:' + colors[d.color] + '"></i><span>' + d.label + '</span></div>'; }).join('') + '</div>';
  }
  function slaLive() {
    var sp = D.live.avgResponseTime == null ? null : Math.round(D.live.avgResponseTime / 1000);
    var today = D.live.today == null ? null : Math.round(D.live.today / 1000), m30 = D.live.thirtyDayAvg == null ? null : Math.round(D.live.thirtyDayAvg / 1000);
    var od = lazy('sla:overdue', '/sla/overdue'), tr = lazy('sla:trend', '/sla/trend'), tm = lazy('sla:team', '/sla/team');
    var ct = planOk('watchtower') ? lazy('sla:cross', '/sla/cross-tool') : null;
    var dayPanel = '';
    if (S.slaDay != null && tr && !tr.__error) {
      var date = tr.days[S.slaDay].date, dd = lazy('sla:day:' + date, '/sla/trend?date=' + date);
      dayPanel = '<div class="card" style="margin-top:16px;background:var(--bg-elevated)"><div class="spread"><b>' + new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }) + '</b><button class="close" data-act="slaDay" data-v="">' + ic('x', 14) + '</button></div>' +
        (!dd ? skel(1) : dd.__error ? errBox(dd) : '<dl class="kv" style="grid-template-columns:1fr auto;margin-top:8px"><dt>Avg response</dt><dd class="' + speedClass(dd.avgMs == null ? null : dd.avgMs / 1000) + '">' + dur(dd.avgMs, true) + '</dd><dt>Leads received</dt><dd>' + dd.received + '</dd><dt>Responded</dt><dd>' + dd.responded + '</dd><dt>Overdue</dt><dd class="' + (dd.overdue ? 'red' : '') + '">' + dd.overdue + '</dd><dt>Fastest</dt><dd class="green">' + dur(dd.fastestMs, true) + '</dd><dt>Slowest</dt><dd class="' + (dd.slowestOverThreshold ? 'red' : '') + '">' + dur(dd.slowestMs, true) + '</dd></dl>' +
          (dd.team.length ? '<div class="label" style="margin-top:12px">Fastest that day</div>' + dd.team.map(function (t) { return '<div class="list-row">' + av(t.id, 24) + '<span class="grow">' + esc(t.name) + '</span><b>' + dur(t.avgMs, true) + '</b></div>'; }).join('') : '')) + '</div>';
    }
    return '<div class="sla-grid">' +
      '<div class="card"><div class="label">Avg response time</div><div style="font:700 56px/1 var(--f-display);margin-top:12px;letter-spacing:-0.01em" class="' + speedClass(sp) + '">' + secs(sp) + '</div>' +
      (today != null && m30 != null ? '<div class="small" style="margin-top:10px">Today ' + secs(today) + ' vs 30-day avg ' + secs(m30) + ' <span class="' + (today <= m30 ? 'green' : 'red') + '">' + ic(today <= m30 ? 'arrowDown' : 'arrowUp', 12) + ' ' + secs(Math.abs(today - m30)) + (today <= m30 ? ' faster' : ' slower') + '</span></div>' : '') +
      '<div class="divider"></div>' + (!tm ? skel(3) : tm.__error ? errBox(tm) : tm.map(function (u) { var w = u.avgThisWeekMs == null ? null : u.avgThisWeekMs / 1000, a = u.avg30dMs == null ? null : u.avg30dMs / 1000; return '<div class="list-row">' + av(u.id, 28) + '<span class="grow">' + esc(u.name) + '</span><span class="ts" style="width:80px">This week</span><b class="' + (u.improving === false ? 'red' : 'green') + '" style="width:80px">' + secs(w) + '</b><span class="ts" style="width:110px">30d ' + secs(a) + '</span></div>'; }).join('')) + '</div>' +
      '<div class="col gap24"><div class="card"><div class="label">SLA trend · 7 days</div>' + (!tr ? skel(1) : tr.__error ? errBox(tr) : trendBars(tr.days, S.slaDay)) + dayPanel + '</div>' +
      '<div class="card"><div class="spread"><div class="label">Overdue now</div><span class="badge b-red">' + (od && !od.__error ? od.count : '…') + '</span></div>' + (!od ? skel(2) : od.__error ? errBox(od) : od.count ? od.leads.map(overdueRow).join('') : okEmpty()) + '</div></div></div>' +
      (planOk('watchtower') ? '<div class="card" style="margin-top:24px"><div class="h3">Cross-tool SLA breaches</div>' + (!ct ? skel(2) : ct.__error ? errBox(ct) : !ct.connected ? '<div class="small" style="margin-top:8px">Connect a CRM or email platform to monitor cross-tool SLA. <a href="#/settings/integrations">Go to Integrations</a></div>' :
        ct.breaches.length ? ct.breaches.map(function (b) { return '<div class="list-row"><span class="badge nodot ' + ({ crm: 'b-purple', email: 'b-blue', ads: 'b-amber', slack: 'b-grey' }[b.type] || 'b-grey') + '" style="width:80px;justify-content:center">' + (b.type || '').toUpperCase() + '</span><b style="width:160px">' + esc(b.leadName) + '</b><span class="grow small">' + esc(RULES[b.breachType] || b.breachType) + '</span><span style="width:120px">' + esc(b.assigneeName || '—') + '</span><span class="overdue-t" style="width:70px">+' + b.hoursExceeded + 'h</span><a class="btn btn-ghost btn-sm" href="#/leads/' + b.leadId + '">View Lead</a></div>'; }).join('') : '<div class="small" style="margin-top:8px">No cross-tool breaches right now.</div>') + '</div>' : '') +
      '<div class="card" style="margin-top:24px"><div class="h3">Team SLA health</div><div class="small" style="margin-bottom:8px">Data only. No ranking.</div>' +
      (!tm || tm.__error ? '' : tm.map(function (u) { return '<div class="list-row">' + av(u.id, 28) + '<span class="grow">' + esc(u.name) + '</span><span style="width:140px">Avg ' + secs(u.avgThisWeekMs == null ? null : u.avgThisWeekMs / 1000) + '</span><span style="width:140px">Ack rate ' + (u.acknowledgmentRate == null ? '—' : Math.round(u.acknowledgmentRate * 100) + '%') + '</span><span style="width:110px" class="' + (u.breachesThisWeek ? 'red' : 'green') + '">' + u.breachesThisWeek + ' breaches</span></div>'; }).join('')) + '</div>';
  }
  var RULES = { not_contacted: 'Not moved to "Contacted" within threshold', not_proposal: 'Not moved to "Proposal Sent" within threshold', no_activity: 'No activity logged within threshold', not_enrolled: 'Not enrolled in follow-up sequence', open_rate_drop: 'Open rate dropped below threshold', no_click: 'No click recorded', spend_without_leads: 'Spending with zero leads', cpl_exceeded: 'CPL exceeded', spend_increase: 'Spend up without lead growth', discussed_not_acted: 'Discussed in Slack but not acted on' };
  function slaConfig() {
    var cfg = lazy('sla:config', '/sla/config');
    var ct = planOk('watchtower') ? lazy('sla:crossConfig', '/sla/config/cross-tool') : [];
    if (!cfg) return skel(4);
    if (cfg.__error) return errBox(cfg);
    function rule(r) {
      var unit = r.thresholdUnit === 'percent' ? '%' : r.thresholdUnit === 'currency' ? 'amount' : r.thresholdUnit;
      return '<div class="rule-row ' + (r.enabled ? '' : 'off') + '" data-rule="' + r.id + '"><button class="toggle ' + (r.enabled ? 'on' : '') + '" data-act="ruleToggle"></button><span>' + esc(RULES[r.ruleType] || r.ruleType) + '</span><input class="input" type="number" min="0" value="' + r.thresholdValue + '" ' + (r.enabled ? '' : 'disabled') + ' /><span class="small">' + unit + '</span></div>';
    }
    function notifyRow(r) { return '<div class="row wrap gap16" style="margin-top:12px"><span class="small">Notify via:</span>' + [['ai_panel', 'AI Panel'], ['email', 'Email'], ['telegram', 'Telegram']].map(function (x) { return '<label class="checkbox"><input type="checkbox" data-ch="' + x[0] + '" ' + (r.notificationChannels.indexOf(x[0]) >= 0 ? 'checked' : '') + '/> ' + x[1] + '</label>'; }).join('') + '</div>'; }
    var tools = !ct ? skel(2) : ct.__error ? errBox(ct) : ct.length ? ct.map(function (t) {
      return '<div class="intcard" data-integration="' + t.integrationId + '"><div class="spread"><div class="h3" style="font-size:14px">' + esc(INT_NAMES[t.provider] || t.provider) + '</div><span class="badge b-green">Connected</span></div><div class="ts">Connection: ' + esc(t.method || '') + '</div><div class="small">After a lead is acknowledged in Camplo, flag it if:</div>' + t.rules.map(rule).join('') + (t.rules[0] ? notifyRow(t.rules[0]) : '') + '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-act="saveCross" data-id="' + t.integrationId + '">Save Changes</button></div></div>';
    }).join('') : '<div class="card"><div class="small">Connect a CRM or email platform to configure cross-tool SLA monitoring.</div><a class="btn btn-ghost" style="margin-top:12px" href="#/settings/integrations">Go to Integrations</a></div>';
    return '<div style="max-width:960px"><div class="card"><div class="h3">Response threshold</div><div class="row wrap" style="margin-top:12px"><span class="small">Leads unacknowledged after</span><input class="input" type="number" min="1" style="width:90px" value="' + (cfg.sla_threshold_minutes % 60 === 0 && cfg.sla_threshold_minutes >= 60 ? cfg.sla_threshold_minutes / 60 : cfg.sla_threshold_minutes) + '" id="slaMin" /><select class="select" style="width:130px" id="slaUnit"><option value="1">Minutes</option><option value="60"' + (cfg.sla_threshold_minutes % 60 === 0 && cfg.sla_threshold_minutes >= 60 ? ' selected' : '') + '>Hours</option></select><span class="small">will be marked overdue.</span></div>' +
      '<div class="setting-row" style="margin-top:12px"><div><b>VIP lead rules</b><div class="small">VIP pages get a tighter threshold.</div></div><button class="toggle ' + (cfg.vip_lead_enabled ? 'on' : '') + '" id="vipToggle" data-act="toggle"></button></div>' +
      '<div class="row wrap" style="margin-top:8px"><span class="small">VIP threshold (minutes)</span><input class="input" type="number" min="1" style="width:90px" id="vipMin" value="' + cfg.vip_sla_threshold_minutes + '"/><span class="small">Daily digest time (UTC)</span><input class="input" type="time" style="width:120px" id="digestTime" value="' + cfg.daily_summary_time + '"/></div>' +
      '<div class="label" style="margin-top:16px">VIP pages</div>' + cfg.vipPages.map(function (p) { return '<div class="setting-row"><span class="mono">' + esc(p.name) + '</span><button class="toggle ' + (p.vip ? 'on' : '') + '" data-act="toggle" data-vip="' + p.id + '"></button></div>'; }).join('') +
      '<div class="row" style="justify-content:flex-end;margin-top:12px"><span class="errmsg hidden" id="slaErr"></span><button class="btn btn-primary" data-act="saveSla">Save Changes</button></div></div>' +
      '<div class="section-label"><span class="h2">Cross-Tool SLA Monitoring</span></div><div class="small italic" style="color:var(--text-muted);margin:-4px 0 16px">Monitor SLA across the entire lead journey — not just first acknowledgment.</div>' +
      (planOk('watchtower') ? '<div class="col gap16">' + tools + '</div>' : '<div class="card"><div class="spread"><div class="small">Cross-tool SLA monitoring is part of Watchtower.</div>' + planChip('watchtower') + '</div></div>') +
      '<div class="card" style="margin-top:16px"><div class="h3">Notification rules</div>' + cfg.notificationRules.map(function (u) {
        return '<div class="setting-row" data-member="' + u.id + '"><span class="row">' + av(u.id, 28) + esc(u.name) + '</span><span class="row"><select class="select" style="width:140px;height:34px">' + ['email', 'telegram', 'both'].map(function (c) { return '<option value="' + c + '"' + (u.notifyChannel === c ? ' selected' : '') + '>' + cap(c) + '</option>'; }).join('') + '</select><button class="toggle ' + (u.notifyEnabled ? 'on' : '') + '" data-act="toggle"></button></span></div>';
      }).join('') + '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" data-act="saveRules">Save</button></div></div></div>';
  }

  // ================================================================ Team Notes + My Performance
  function teamNoteCard(t) {
    var dl = '';
    if (t.deadline) {
      var left = ms(t.deadline) - Date.now();
      var cls = t.deadlineStatus === 'met' ? 'b-green' : t.deadlineStatus === 'expired' || left < 0 ? 'b-red' : left < HOUR ? 'b-amber' : 'b-grey';
      dl = '<span class="badge nodot ' + cls + '">' + ic('clock', 11) + ' ' + (t.deadlineStatus === 'met' ? 'Met' : left < 0 ? 'Expired ' + ago(ms(t.deadline)) : 'Due ' + clock(ms(t.deadline))) + '</span>';
    }
    var att = t.attachment ? (t.attachment.type === 'lead' ? '<a class="chip" href="#/leads/' + t.attachment.id + '">Lead: ' + esc(t.attachment.name) + ' →</a>' : '<a class="chip" href="#/campaigns/' + t.attachment.id + '/notes">Campaign: ' + esc(t.attachment.name) + ' →</a>') : '';
    var border = t.unread && t.approaching ? 'border-left:3px solid var(--status-red)' : t.unread ? 'border-left:3px solid var(--accent-blue)' : t.deadlineStatus === 'expired' ? 'border-left:3px solid var(--status-red)' : '';
    return '<article class="card" style="padding:16px;' + border + '" data-teamnote="' + t.id + '" data-unread="' + (t.unread ? 1 : 0) + '"><div class="row">' + av(t.authorId) + '<div class="grow"><div class="row"><b style="font-size:13px">' + esc(t.authorName) + '</b><span class="ts" data-ago="' + ms(t.createdAt) + '"></span>' + (t.editable ? '<button class="edit-pen" style="opacity:1" data-act="editTeamNote" data-id="' + t.id + '">' + ic('pen', 13) + '</button>' : '') + '</div>' +
      (t.editedAt ? '<div class="edited">Edited · ' + new Date(t.editedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</div>' : '') + '</div>' + dl + '</div>' +
      '<div class="row wrap" style="margin:10px 0 0 40px">' + t.recipients.map(function (u) { return '<span class="chip chip-blue">@' + esc(u.name.split(' ')[0]) + '</span>'; }).join('') + att + '</div>' +
      (S.editNote === t.id ? '<div style="margin:8px 0 0 40px"><textarea class="input" id="editNoteInput">' + esc(t.content) + '</textarea><div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="saveNote" data-id="' + t.id + '" data-team="1">Save</button><button class="btn btn-ghost btn-sm" data-act="cancelNote">Cancel</button></div></div>'
        : '<div style="margin:8px 0 0 40px;white-space:pre-wrap">' + esc(t.content) + '</div>') +
      (t.editable ? '<div class="editable-for" style="margin:4px 0 0 40px" data-until="' + ms(t.editableUntil) + '" data-prefix="Editable for "></div>' : '') +
      (t.canAcknowledge ? '<div style="margin:10px 0 0 40px"><button class="btn btn-primary btn-sm" data-act="ackTeamNote" data-id="' + t.id + '">Acknowledge</button></div>' : '') + '</article>';
  }
  function teamNotesScreen() {
    if (!planOk('growth')) return '<div class="page"><h1 class="h1">Team Notes</h1><div class="card" style="margin-top:16px"><div class="spread"><div class="small">Address notes to teammates with deadlines and attachments.</div>' + planChip('growth') + '</div></div></div>';
    var list = D.teamNotes;
    var compose = canManage() ? '<aside class="rail"><div class="card"><div class="h3">New team note</div><div class="field" style="margin-top:12px"><label>To</label><div class="col gap4" id="tnTo">' +
      D.team.filter(function (u) { return u.id !== D.me.id; }).map(function (u) { return '<label class="checkbox"><input type="checkbox" value="' + u.id + '"/> @' + esc(u.name) + '</label>'; }).join('') + '</div></div>' +
      '<div class="field" style="margin-top:12px"><label>Attach to (optional)</label><select class="select" id="tnAttach"><option value="">Standalone</option>' + D.campaigns.map(function (c) { return '<option value="campaign:' + c.id + '">Campaign: ' + esc(c.name) + '</option>'; }).join('') +
      D.leads.filter(function (l) { return !l.respondedAt; }).slice(0, 30).map(function (l) { return '<option value="lead:' + l.id + '">Lead: ' + esc(l.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="margin-top:12px"><label>Deadline (optional)</label><input class="input" type="datetime-local" id="tnDue" /></div>' +
      '<textarea class="input" id="tnBody" style="margin-top:12px" placeholder="Write a note… Notes cannot be deleted once posted."></textarea><span class="errmsg hidden" id="tnErr"></span><button class="btn btn-primary btn-full" style="margin-top:12px" data-act="postTeamNote">Post Team Note</button></div></aside>' : '';
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Team Notes</h1><div class="small italic" style="color:var(--text-muted);margin-top:6px">The complete workspace record. Notes cannot be deleted. Editable within 2 hours.</div></div><a class="btn btn-ghost" href="#/me">Notes addressed to me</a></div>' +
      '<div class="dossier" style="grid-template-columns:' + (compose ? 'minmax(0,1fr) 380px' : '1fr') + '"><div class="col gap12">' + (list.length ? list.map(teamNoteCard).join('') : empty('note', 'No team notes yet.', canManage() ? 'Leave the first note for a teammate.' : '')) + '</div>' + compose + '</div></div>';
  }
  function myPerformance() {
    var me = byId(D.team, D.me.id) || {};
    var mine = D.leads.filter(function (l) { return l.assignee === D.me.id && !l.respondedAt; });
    var addressed = D.teamNotes.filter(function (t) { return t.addressedToMe; });
    var unread = addressed.filter(function (t) { return t.unread; }).length;
    return '<div class="page"><div class="page-head"><div class="row gap12">' + av(D.me.id, 40) + '<div><h1 class="h1">My Performance</h1><div class="small" style="margin-top:6px">Your own numbers, for your own growth. Not a leaderboard.</div></div></div></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi"><div class="label">Speed-to-lead (week)</div><div class="display ' + speedClass(me.week) + '" style="font-size:36px">' + secs(me.week) + '</div>' + (me.week != null && me.avg30 != null ? '<div class="kpi-sub ' + (me.week <= me.avg30 ? 'green' : 'red') + '">' + ic(me.week <= me.avg30 ? 'arrowDown' : 'arrowUp', 11) + ' ' + secs(Math.abs(me.avg30 - me.week)) + (me.week <= me.avg30 ? ' faster' : ' slower') + ' than your 30d avg</div>' : '') + '</div>' +
      '<div class="kpi"><div class="label">Leads responded</div><div class="display" style="font-size:36px">' + (me.respondedWeek || 0) + '</div><div class="kpi-sub">This week</div></div>' +
      '<div class="kpi"><div class="label">SLA breaches</div><div class="display ' + (me.breaches ? 'red' : 'green') + '" style="font-size:36px">' + (me.breaches || 0) + '</div><div class="kpi-sub">This week</div></div>' +
      '<div class="kpi"><div class="label">Fastest response</div><div class="display green" style="font-size:36px">' + dur(me.fastest, true) + '</div><div class="kpi-sub">This week</div></div></div>' +
      '<div class="sla-grid"><div><div class="h3" style="margin-bottom:12px">Assigned to you</div>' + (mine.length ? leadTable(mine) : '<div class="card small">Nothing assigned to you right now.</div>') + '</div>' +
      '<div><div class="h3" style="margin-bottom:12px">Notes for you ' + (unread ? '<span class="badge b-blue">' + unread + '</span>' : '') + '</div><div class="col gap12">' + (addressed.length ? addressed.map(teamNoteCard).join('') : empty('note', 'No notes for you.', '')) + '</div></div></div></div>';
  }

  // ================================================================ Settings (Screen 13 / 20)
  function settingsScreen(tab) {
    var tabs = [['workspace', 'Workspace'], ['team', 'Team'], ['ai', 'AI Provider'], ['telegram', 'Telegram'], ['integrations', 'Integrations'], ['webhooks', 'Webhooks & API'], ['notifications', 'Notifications']];
    if (!isOwner()) tabs = tabs.filter(function (t) { return t[0] === 'team'; });
    var body = { workspace: setWorkspace, team: setTeam, ai: setAI, telegram: setTelegram, integrations: setIntegrations, webhooks: setWebhooks, notifications: setNotifications }[tab] || setTeam;
    if (!isOwner() && tab !== 'team') body = setTeam;
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Settings</h1><div class="small" style="margin-top:6px">' + esc(D.ws.name) + ' · ' + cap(D.plan) + ' plan</div></div></div>' +
      '<nav class="settings-tabs">' + tabs.map(function (t) { return '<a class="subtab ' + (tab === t[0] ? 'active' : '') + '" href="#/settings/' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' + body() + '</div>';
  }
  function setWorkspace() {
    var used = D.ws.storageUsedBytes, quota = D.ws.storageQuotaBytes;
    return '<div class="card" style="max-width:720px"><div class="field"><label>Workspace name</label><div class="row"><input class="input" id="wsName" value="' + esc(D.ws.name) + '"/><button class="btn btn-primary" data-act="saveWs">Save</button></div></div>' +
      '<div class="field" style="margin-top:20px"><label>Logo</label><div class="row">' + (D.ws.logoUrl ? '<img src="' + esc(D.ws.logoUrl) + '" alt="Logo" style="width:64px;height:64px;border-radius:8px;object-fit:contain;background:var(--bg-elevated)"/>' : '<span class="avatar s64">' + esc(D.ws.name[0] || 'C') + '</span>') +
      '<label class="btn btn-ghost">Upload logo<input type="file" accept="image/png,image/jpeg" hidden data-act-change="logo"/></label>' + (D.ws.logoUrl ? '<button class="btn btn-ghost" data-act="removeLogo">Remove</button>' : '') + '</div><div class="ts italic">Used in Campaign Retrospective PDFs.</div></div>' +
      '<div class="field" style="margin-top:20px"><label>Storage</label><div class="progress"><i style="width:' + Math.min(100, used / quota * 100).toFixed(1) + '%"></i></div><div class="ts">' + (used / 1048576).toFixed(1) + ' MB of ' + (quota / 1073741824).toFixed(0) + ' GB used</div></div></div>';
  }
  function setTeam() {
    var inv = canManage() ? lazy('set:invites', '/team/invitations') : [];
    return '<div class="spread" style="margin-bottom:16px"><div class="h2">Team</div>' + (canManage() ? '<button class="btn btn-primary" data-act="invite">Invite Member</button>' : '') + '</div>' +
      (D.team.length === 1 ? empty('plus', 'Invite your first team member.', '', canManage() ? '<button class="btn btn-primary" data-act="invite">Invite</button>' : '') : '') +
      '<div class="table-wrap">' + D.team.map(function (u) {
        var rb = { OWNER: 'b-grey', ADMIN: 'b-blue', MEMBER: 'b-grey' }[u.role];
        var acts = '';
        if (u.role !== 'OWNER' && isOwner()) acts = '<button class="linkbtn" data-act="editRole" data-id="' + u.id + '">Edit role</button><button class="linkbtn" style="color:var(--status-red)" data-act="removeMember" data-id="' + u.id + '">Remove</button>';
        return '<div class="member-row" data-act="member" data-id="' + u.id + '">' + av(u.id, 40) + '<b>' + esc(u.name) + '</b><span class="sec">' + esc(u.email) + '</span><span class="badge nodot ' + rb + '">' + u.role + '</span><span class="ts" data-ago="' + u.lastActive + '"></span><span class="acts">' + acts + '</span></div>';
      }).join('') + '</div>' +
      (inv && !inv.__error && inv.length ? '<div class="section-label"><span class="label">Pending invitations</span></div><div class="table-wrap">' + inv.map(function (i) {
        return '<div class="member-row" style="cursor:default"><span class="avatar s40">@</span><b>' + esc(i.email) + '</b><span class="sec">Invited ' + ago(ms(i.invitedAt)) + '</span><span class="badge nodot ' + (i.status === 'expired' ? 'b-red' : 'b-grey') + '">' + i.status.toUpperCase() + '</span><span></span><span class="acts" style="opacity:1"><button class="linkbtn" data-act="resendInvite" data-id="' + i.id + '">Resend</button><button class="linkbtn" data-act="cancelInvite" data-id="' + i.id + '">Cancel ×</button></span></div>';
      }).join('') + '</div>' : '');
  }
  var PROVIDERS = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['deepseek', 'DeepSeek'], ['mimo', 'MiMo'], ['arcee', 'Arcee'], ['gemini', 'Google'], ['glm', 'GLM'], ['minimax', 'MiniMax'], ['bytedance', 'ByteDance / Seed'], ['kimi', 'Kimi / Moonshot'], ['groq', 'Groq'], ['mistral', 'Mistral'], ['xai', 'xAI'], ['qwen', 'Qwen'], ['openrouter', 'OpenRouter'], ['other', 'Other']];
  function statusBadge(s) { return '<span class="badge ' + ({ connected: 'b-green', failed: 'b-red', not_connected: 'b-grey' }[s] || 'b-grey') + '">' + (s || 'not_connected').replace('_', ' ') + '</span>'; }
  function providerBlock(which, v, title, sub) {
    return '<div class="card" data-provider="' + which + '"><div class="spread"><div><div class="h3">' + title + '</div>' + (sub ? '<div class="small">' + sub + '</div>' : '') + '</div>' + statusBadge(v.status) + '</div><div class="form-grid" style="margin-top:16px">' +
      '<div class="field"><label>Provider</label><select class="select" data-f="provider"><option value="">Choose…</option>' + PROVIDERS.map(function (p) { return '<option value="' + p[0] + '"' + (v.provider === p[0] ? ' selected' : '') + '>' + p[1] + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Model name</label><input class="input" data-f="modelName" value="' + esc(v.modelName || '') + '" placeholder="Enter model name e.g. claude-sonnet-5" /></div>' +
      '<div class="field" style="grid-column:1/-1"><label>API key</label><div class="row"><div class="grow input-wrap"><input class="input mono" type="password" data-f="apiKey" id="key-' + which + '" placeholder="' + esc(v.apiKeyMasked || 'Paste API key') + '" style="font-size:12px"/><span class="acts"><button data-act="eye" data-for="key-' + which + '">' + ic('eye', 14) + '</button></span></div><button class="btn btn-primary" data-act="verifyAi" data-v="' + which + '">Verify</button></div><div class="ts">Keys are encrypted (AES-256-GCM) and never sent to the browser again.</div></div></div></div>';
  }
  function setAI() {
    var v = lazy('set:ai', '/settings/ai-provider');
    if (!v) return skel(3);
    if (v.__error) return errBox(v);
    return '<div class="col gap16" style="max-width:860px"><div class="banner blue">' + ic('brain', 15) + (v.camploProvidedAi ? ' Camplo-provided AI is on. Bring your own key to pay your provider directly — it does not change which features your plan includes.' : ' No Camplo-provided AI key is configured on this server. Connect your own key to enable LLM-powered recommendations and chat — rule-based intelligence works without one.') + '</div>' +
      (v.usingFallback ? '<div class="small italic muted" style="color:var(--text-muted)">Using fallback provider</div>' : '') +
      (v.primary.status === 'failed' ? '<div class="banner amber">' + ic('warn', 15) + ' AI observations paused — check your API key.</div>' : '') +
      (v.advancedUsage >= 0.8 ? '<div class="banner amber">' + ic('warn', 15) + (v.advancedUsage >= 1 ? ' You\'ve reached the advanced intelligence included in your plan. Standard intelligence remains available.' : " You're approaching your plan's advanced intelligence limit.") + '</div>' : '') +
      providerBlock('primary', v.primary, 'Primary provider') +
      '<div class="card"><div class="spread"><div><div class="h3">Fallback provider</div><div class="small">Fallback — used automatically if primary fails</div></div><button class="toggle ' + (v.fallback.enabled ? 'on' : '') + '" id="fbToggle" data-act="toggle"></button></div></div>' +
      (v.fallback.enabled ? providerBlock('fallback', v.fallback, 'Fallback provider') : '') +
      '<div class="card"><div class="h3">Intelligence schedule</div><div class="row wrap" style="margin-top:12px"><span class="small">AI observations refresh every</span><input class="input" type="number" min="5" style="width:90px" id="aiEvery" value="' + v.refreshIntervalMinutes + '" /><span class="small">minutes</span></div>' +
      '<div class="small" style="margin-top:16px">Also refresh when:</div><div class="row wrap gap16" style="margin-top:8px" id="aiTriggers">' + [['sla_breach', 'SLA breach'], ['webhook_silence', 'Webhook silence'], ['lead_batch', 'New lead batch'], ['budget_threshold', 'Budget threshold crossed']].map(function (x) { return '<label class="checkbox"><input type="checkbox" value="' + x[0] + '" ' + (v.eventTriggers.indexOf(x[0]) >= 0 ? 'checked' : '') + '/> ' + x[1] + '</label>'; }).join('') + '</div></div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-act="saveAi">Save</button></div></div>';
  }
  function setTelegram() {
    var v = lazy('set:tg', '/settings/telegram');
    if (!v) return skel(2);
    if (v.__error) return errBox(v);
    return '<div class="card" style="max-width:720px"><div class="spread"><div class="h3">Telegram alerts</div>' + statusBadge(v.connected ? 'connected' : 'not_connected') + '</div>' + (v.botUsername ? '<div class="small">Bot: @' + esc(v.botUsername) + ' · each teammate links their chat by sending <span class="mono">/start ' + esc(D.me.id.slice(0, 8)) + '</span> (their own code) to the bot.</div>' : '') +
      '<div class="field" style="margin-top:16px"><label>Bot token</label><div class="row"><div class="grow input-wrap"><input class="input mono" type="password" id="tgToken" placeholder="' + esc(v.tokenMasked || '123456:ABC-DEF…') + '" style="font-size:12px"/><span class="acts"><button data-act="eye" data-for="tgToken">' + ic('eye', 14) + '</button></span></div><button class="btn btn-primary" data-act="verifyTg">Verify & Connect</button></div></div>' +
      '<div class="setting-row" style="margin-top:12px"><div><b>Enable critical alerts</b><div class="small">SLA breaches with an inline Acknowledge button</div></div><button class="toggle ' + (v.criticalAlertsEnabled ? 'on' : '') + '" data-act="tgToggle" data-v="criticalAlertsEnabled"></button></div>' +
      '<div class="setting-row"><div><b>Daily digest summary</b></div><button class="toggle ' + (v.dailyDigestEnabled ? 'on' : '') + '" data-act="tgToggle" data-v="dailyDigestEnabled"></button></div>' +
      (v.connected ? '<button class="btn btn-ghost" style="margin-top:12px" data-act="disconnectTg">Disconnect</button>' : '') + '</div>';
  }
  var INT_NAMES = {};
  var INT_LOGO = { systeme_io: ['S', '#2E7DF6'], gohighlevel: ['GH', '#1E88E5'], tally: ['T', '#111'], typeform: ['Tf', '#262627'], custom: ['{}', '#363650'], instantly: ['In', '#5B3DF5'], apollo: ['Ap', '#3A3AFF'], lemlist: ['Le', '#6C4CF6'], smartlead: ['Sm', '#0F766E'], twenty_crm: ['20', '#222'], hubspot: ['H', '#FF7A59'], salesforce: ['Sf', '#00A1E0'], umami: ['U', '#333'], activecampaign: ['AC', '#356AE6'], mailchimp: ['Mc', '#C9A300'], brevo: ['Br', '#0B996E'], notifuse: ['N', '#444'], meta_ads: ['M', '#0866FF'], google_ads: ['G', '#34A853'], slack: ['Sl', '#4A154B'], zapier: ['Z', '#FF4F00'], make: ['Mk', '#6D00CC'] };
  function setIntegrations() {
    var v = lazy('set:int', '/integrations');
    if (!v) return skel(4);
    if (v.__error) return errBox(v);
    var groups = [], by = {};
    v.forEach(function (i) { INT_NAMES[i.provider] = i.name; if (!by[i.category]) { by[i.category] = []; groups.push(i.category); } by[i.category].push(i); });
    return groups.map(function (g) {
      return '<div class="section-label"><span class="label">' + esc(g) + '</span></div><div class="int-grid">' + by[g].map(function (i) {
        var soon = i.status === 'coming_soon', lg = INT_LOGO[i.provider] || ['?', '#333'];
        var badge = { connected: '<span class="badge b-green">Connected</span>', not_connected: '<span class="badge b-grey">Not connected</span>', failed: '<span class="badge b-red">Connection failed</span>', coming_soon: '<span class="badge b-grey">Coming soon</span>' }[i.status];
        return '<div class="intcard ' + (soon ? 'soon' : '') + '"><div class="spread"><div class="row"><span class="int-logo" style="background:' + lg[1] + '">' + lg[0] + '</span><div class="h3" style="font-size:14px">' + esc(i.name) + '</div></div>' + badge + '</div>' +
          (i.blurb ? '<div class="small">' + esc(i.blurb) + '</div>' : '') +
          '<div class="row wrap">' + i.methods.map(function (m) { return '<span class="chip">' + { webhook: 'Webhook', api_key: 'API Key', oauth: 'OAuth' }[m] + '</span>'; }).join('') + '</div>' +
          (i.status === 'connected' ? '<div class="row wrap">' + [['receive', 'Receiving'], ['send', 'Sending'], ['query', 'Querying']].map(function (m) { return '<span class="badge ' + (i.activeModes.indexOf(m[0]) >= 0 ? 'b-green' : 'b-grey') + '">' + m[1] + '</span>'; }).join('') + '</div>' +
            (i.apiKeyMasked ? '<div class="mono">' + esc(i.apiKeyMasked) + '</div>' : '') + (i.webhookUrl ? '<div class="row"><span class="mono grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(i.webhookUrl) + '</span><button class="close" data-act="copy" data-v="' + esc(i.webhookUrl) + '">' + ic('copy', 14) + '</button></div>' : '') : '') +
          (i.status === 'failed' ? '<button class="linkbtn" data-act="connectInt" data-v="' + i.provider + '">Re-enter credentials</button>' : '') +
          (soon ? '' : '<div class="row" style="justify-content:flex-end">' + (i.status === 'connected' ? '<button class="btn btn-ghost btn-sm" data-act="verifyInt" data-v="' + i.provider + '">Verify</button><button class="btn btn-ghost btn-sm" data-act="disconnectInt" data-v="' + i.provider + '">Disconnect</button>' : '<button class="btn btn-primary btn-sm" data-act="connectInt" data-v="' + i.provider + '">Connect</button>') + '</div>') + '</div>';
      }).join('') + '</div>';
    }).join('');
  }
  var EVENTS = ['lead.responded', 'lead.assigned', 'lead.received', 'campaign.completed', 'sla.breached', 'deployment.ready'];
  function setWebhooks() {
    var inb = lazy('set:inbound', '/webhooks/inbound'), out = lazy('set:outbound', '/webhooks/outbound'), ints = lazy('set:int', '/integrations');
    if (!inb || !out) return skel(4);
    return '<div class="col gap16" style="max-width:1080px"><div class="card"><div class="spread wrap"><div><div class="h3">Inbound webhooks</div><div class="small">External tools send lead data to these URLs. Camplo receives and attributes it automatically. Every hosted page also has its own signed webhook (see Pages).</div></div></div>' +
      '<div style="margin-top:12px">' + (inb.__error ? errBox(inb) : inb.length ? inb.map(function (w) { return '<div class="list-row"><span class="mono grow" style="word-break:break-all">' + esc(w.url) + '</span><span style="width:220px">' + esc(w.sourceLabel) + (w.campaignName ? '<div class="ts">→ ' + esc(w.campaignName) + '</div>' : '') + '</span><span class="ts" style="width:110px">' + ago(ms(w.lastReceivedAt)) + '</span><span class="badge ' + (w.status === 'active' ? 'b-green' : 'b-grey') + '">' + w.status + '</span><button class="close" data-act="copy" data-v="' + esc(w.url) + '">' + ic('copy', 14) + '</button><button class="close" data-act="deleteInbound" data-id="' + w.id + '">' + ic('x', 14) + '</button></div>'; }).join('') : '<div class="small">No named inbound webhooks yet.</div>') + '</div>' +
      '<div class="row wrap" style="margin-top:12px"><input class="input" id="ibLabel" placeholder="Source label e.g. Facebook Ads — Black Friday" style="max-width:320px"/><select class="select" id="ibCamp" style="width:220px"><option value="">No campaign</option>' + D.campaigns.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') + '</select><button class="btn btn-primary" data-act="createInbound">Add Inbound Webhook</button></div></div>' +
      '<div class="card"><div><div class="h3">Outbound webhooks</div><div class="small">Camplo sends events to these URLs — signed with HMAC-SHA256 in X-Camplo-Signature when a secret is set.</div></div><div style="margin-top:12px">' +
      (out.__error ? errBox(out) : out.length ? out.map(function (w) { return '<div class="list-row"><span class="mono grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(w.destinationUrl) + '</span><span class="chip">' + esc(w.eventTrigger) + '</span><span class="ts" style="width:110px">' + (w.lastSentAt ? ago(ms(w.lastSentAt)) : 'never sent') + '</span><span class="badge ' + (w.status === 'active' ? 'b-green' : 'b-grey') + '">' + w.status + '</span><button class="close" data-act="deleteOutbound" data-id="' + w.id + '">' + ic('x', 14) + '</button></div>'; }).join('') : '<div class="small">No outbound webhooks yet.</div>') + '</div>' +
      '<div class="row wrap" style="margin-top:12px"><input class="input" id="obUrl" placeholder="https://hooks.example.com/camplo" style="max-width:320px"/><select class="select" id="obEvent" style="width:200px">' + EVENTS.map(function (e) { return '<option>' + e + '</option>'; }).join('') + '</select><input class="input" id="obSecret" placeholder="HMAC secret (optional)" style="width:200px"/><button class="btn btn-primary" data-act="createOutbound">Add Outbound Webhook</button></div></div>' +
      '<div class="card"><div class="h3">Third-party integration API keys</div>' + (!ints || ints.__error ? '' : (ints.filter(function (i) { return i.apiKeyMasked; }).map(function (i) { return '<div class="list-row"><span class="grow"><b>' + esc(i.name) + '</b></span><span class="mono">' + esc(i.apiKeyMasked) + '</span>' + statusBadge(i.status) + '<button class="btn btn-ghost btn-sm" data-act="connectInt" data-v="' + i.provider + '">Update key</button></div>'; }).join('') || '<div class="small" style="margin-top:8px">No integrations connected yet. <a href="#/settings/integrations">Go to the Integrations tab.</a></div>')) + '</div>' +
      '<div class="card" style="opacity:0.7"><div class="spread"><div class="h3">Camplo API</div><span class="badge b-grey">Coming soon</span></div><div class="small" style="margin-top:6px">Give external tools access to your Camplo data via our API. Your developer can use this to build custom integrations on top of Camplo.</div><button class="btn btn-ghost" disabled style="margin-top:12px;cursor:not-allowed">Generate API Key</button></div></div>';
  }
  function setNotifications() {
    var v = lazy('set:notif', '/settings/notifications');
    if (!v) return skel(3);
    if (v.__error) return errBox(v);
    function r(k, t, s) { return '<div class="setting-row"><div><b>' + t + '</b>' + (s ? '<div class="small">' + s + '</div>' : '') + '</div><button class="toggle ' + (v[k] ? 'on' : '') + '" data-act="toggle" data-n="' + k + '"></button></div>'; }
    var live = D.live.brief.yesterday;
    return '<div class="sla-grid" style="max-width:1080px"><div class="card">' +
      r('dailyDigest', 'Daily digest email', 'Delivered every morning — only when something is unacknowledged') +
      '<div class="row" style="margin:6px 0 10px"><span class="small">Time (UTC)</span><input class="input" type="time" id="nDigest" value="' + v.dailyDigestTime + '" style="width:120px"/></div>' +
      r('slaBreachAlerts', 'SLA breach alerts') + '<div class="row" style="margin:6px 0 10px"><span class="small">Channel</span><select class="select" id="nChannel" style="width:160px">' + ['email', 'telegram', 'both'].map(function (c) { return '<option value="' + c + '"' + (v.slaBreachChannel === c ? ' selected' : '') + '>' + cap(c) + '</option>'; }).join('') + '</select></div>' +
      r('earlyWarning', '72-hour early warning') + r('budgetAlerts', 'Budget threshold alerts') + r('webhookOffline', 'Webhook offline alerts') +
      '<div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn btn-primary" data-act="saveNotif">Save</button></div></div>' +
      '<div class="glass" style="padding:20px"><div class="label">Digest preview</div><div class="h3" style="margin:8px 0 16px">Your Camplo morning digest</div><dl class="kv" style="grid-template-columns:1fr auto"><dt>Leads received yesterday</dt><dd><b>' + live.received + '</b></dd><dt>Acknowledged</dt><dd class="green"><b>' + live.responded + '</b></dd><dt>Still unacknowledged</dt><dd class="red"><b>' + D.leadsEnv.not_responded + '</b></dd><dt>Top performing deployment</dt><dd class="mono">' + esc((D.pages.slice().sort(function (a, b) { return (b.conv || 0) - (a.conv || 0); })[0] || {}).name || '—') + '</dd></dl></div></div>';
  }

  // ================================================================ public screens (auth, share, acknowledge)
  function authWrap(inner) { return '<div class="auth"><div class="auth-card"><div class="auth-logo">C<span>.</span></div>' + inner + '</div></div>'; }
  function publicScreen(top, r) {
    var q = r.query;
    if (top === 'login') return authWrap('<div style="text-align:center"><div class="h2">Welcome back</div><div class="small">See everything. Miss nothing.</div></div>' +
      (S.flash ? '<div class="banner amber">' + esc(S.flash) + '</div>' : '') +
      '<form class="col gap16" data-form="login"><div class="field"><label>Email</label><input class="input" name="email" type="email" autocomplete="username" required value="' + (S.demo ? 'marcus@northbeam.demo' : '') + '" /></div>' +
      '<div class="field"><div class="spread"><label style="font:500 12px var(--f-body);color:var(--text-secondary)">Password</label><a href="#/forgot-password" style="font-size:12px">Forgot password?</a></div><input class="input" name="password" type="password" autocomplete="current-password" required value="' + (S.demo ? 'camplo-demo' : '') + '"/></div>' +
      '<span class="errmsg hidden" id="formErr"></span><button class="btn btn-primary btn-full" type="submit">Sign in</button></form>' +
      '<div class="card" style="padding:12px;background:var(--bg-elevated)"><div class="small"><b>Demo workspace</b> — marcus@northbeam.demo / camplo-demo</div><button class="linkbtn" style="margin-top:6px" data-act="fillDemo">Use demo credentials</button></div>' +
      '<div class="small" style="text-align:center">New to Camplo? <a href="#/signup">Create a workspace</a></div>');
    if (top === 'signup') return authWrap('<div style="text-align:center"><div class="h2">Create your workspace</div><div class="small">Self-serve. Live in minutes, not weeks.</div></div>' +
      '<form class="col gap16" data-form="signup">' + [['name', 'Name', 'text'], ['email', 'Email', 'email'], ['password', 'Password (min 8 characters)', 'password'], ['workspaceName', 'Workspace name', 'text']].map(function (f) { return '<div class="field"><label>' + f[1] + '</label><input class="input" name="' + f[0] + '" type="' + f[2] + '" required ' + (f[0] === 'password' ? 'minlength="8"' : '') + '/></div>'; }).join('') +
      '<div class="field"><label>Plan</label><select class="select" name="plan"><option value="starter">Starter — $97/mo</option><option value="growth" selected>Growth — $197/mo</option><option value="watchtower">Watchtower — $347/mo</option></select></div>' +
      '<span class="errmsg hidden" id="formErr"></span><button class="btn btn-primary btn-full" type="submit">Create account</button></form><div class="small" style="text-align:center">Already have an account? <a href="#/login">Log in</a></div>');
    if (top === 'forgot' || top === 'forgot-password') return authWrap(S.forgotSent ? '<div class="h2" style="text-align:center">Check your email</div><p class="small" style="text-align:center">If an account exists for ' + esc(S.forgotSent) + ', you\'ll receive a reset link shortly.</p><a href="#/login" class="small" style="text-align:center">← Back to login</a>'
      : '<div class="h2" style="text-align:center">Reset your password</div><form class="col gap16" data-form="forgot"><div class="field"><label>Email</label><input class="input" name="email" type="email" required placeholder="you@company.com" /></div><button class="btn btn-primary btn-full" type="submit">Send Reset Link</button></form><a href="#/login" class="small" style="text-align:center">← Back to login</a>');
    if (top === 'reset-password') return authWrap(S.resetDone ? '<div class="h2" style="text-align:center">Password reset successfully.</div><a class="btn btn-primary btn-full" href="#/login">Sign in</a>'
      : '<div class="h2" style="text-align:center">Choose a new password</div><form class="col gap16" data-form="reset"><input type="hidden" name="token" value="' + esc(q.get('token') || '') + '"/><div class="field"><label>New password</label><input class="input" name="p1" type="password" minlength="8" required /></div><div class="field"><label>Confirm password</label><input class="input" name="p2" type="password" minlength="8" required /><span class="errmsg hidden" id="formErr"></span></div><button class="btn btn-primary btn-full" type="submit">Reset Password</button></form>');
    if (top === 'accept-invite') return authWrap('<div class="h2" style="text-align:center">Join your team on Camplo</div><form class="col gap16" data-form="accept"><input type="hidden" name="token" value="' + esc(q.get('token') || '') + '"/><div class="field"><label>Your name</label><input class="input" name="name" /></div><div class="field"><label>Choose a password</label><input class="input" name="password" type="password" minlength="8" required /></div><span class="errmsg hidden" id="formErr"></span><button class="btn btn-primary btn-full" type="submit">Accept invite</button></form>');
    if (top === 'pending') return authWrap('<div class="h2" style="text-align:center">Your account is under review</div><p class="small" style="text-align:center">Payment received. We activate new workspaces within one business day — you\'ll get an email as soon as yours is live.</p><a href="#/login" class="small" style="text-align:center">Back to login</a>');
    if (top === 'share') return clientView(r.parts[1]);
    if (top === 'acknowledge') return ackView(q.get('token'));
    return '';
  }

  function clientView(token) {
    var v = C['share:' + token];
    if (!v) {
      if (!pending['share:' + token]) pending['share:' + token] = api('/public/campaigns/' + encodeURIComponent(token)).then(function (x) { C['share:' + token] = x; }, function (e) { C['share:' + token] = { __error: e.message }; }).then(function () { delete pending['share:' + token]; render(true); });
      return '<div class="client">' + skel(4) + '</div>';
    }
    if (v.__error) return '<div class="auth"><div class="auth-card" style="text-align:center"><div class="auth-logo">C<span>.</span></div><div class="h3">This report link is no longer active.</div></div></div>';
    var sp = v.speed_to_lead_ms == null ? null : v.speed_to_lead_ms / 1000;
    return '<div class="client"><div class="spread"><div class="logo">C<span>.</span></div><button class="btn btn-ghost btn-sm" data-act="shareRefresh" data-v="' + esc(token) + '">' + ic('refresh', 14) + ' Refresh</button></div>' +
      '<div class="spread wrap" style="margin-top:40px"><h1 class="h1">' + esc(v.campaign_name) + '</h1>' + healthBadge(HEALTH[v.health_pulse]) + '</div><div class="small" style="margin-top:6px">Live campaign performance</div>' +
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-top:28px"><div class="kpi"><div class="label">Total leads</div><div class="display">' + v.lead_count + '</div></div><div class="kpi"><div class="label">Responded</div><div class="display green">' + v.responded_count + '</div></div><div class="kpi"><div class="label">Not responded</div><div class="display red">' + v.not_responded_count + '</div></div><div class="kpi"><div class="label">Speed-to-lead</div><div class="display ' + speedClass(sp) + '" style="font-size:36px">' + secs(sp) + '</div></div></div>' +
      '<div class="h3" style="margin:12px 0">Recent observations</div>' + (v.insights.length ? '<div class="feed">' + v.insights.map(function (i, x) { return '<article class="insight t-blue" style="animation-delay:' + x * 70 + 'ms"><div class="obs">' + esc(i.observation) + '</div><div class="meta"><span class="ts">' + ago(ms(i.generated_at)) + '</span></div></article>'; }).join('') + '</div>' : '<div class="small">No insights generated yet.</div>') +
      '<div class="ts" style="text-align:center;margin-top:48px">Powered by Camplo</div></div>';
  }

  function ackView(token) {
    var key = 'ack:' + token, v = C[key];
    if (!v) {
      if (!pending[key]) pending[key] = api('/leads/acknowledge/preview?token=' + encodeURIComponent(token || '')).then(function (x) { C[key] = x; }, function () { C[key] = { state: 'invalid' }; }).then(function () { delete pending[key]; render(true); });
      return authWrap(skel(2));
    }
    if (v.state === 'done') return authWrap('<div style="text-align:center"><div class="check-big" style="margin:0 auto 12px">' + ic('check', 28) + '</div><div class="h2">You responded to ' + esc(v.lead.name) + ' in ' + dur(v.elapsedMs, true) + '.</div><p class="small">Well done.</p></div>');
    if (v.state === 'already') return authWrap('<div class="h3" style="text-align:center">This lead has already been acknowledged.</div>');
    if (v.state === 'expired') return authWrap('<div class="h3" style="text-align:center">This link has expired. Log in to acknowledge manually.</div><a class="btn btn-ghost btn-full" href="#/login">Log in</a>');
    if (v.state !== 'ok') return authWrap('<div class="h3" style="text-align:center">This link is no longer valid.</div>');
    return authWrap('<div style="text-align:center"><div class="dossier-name" style="font-size:30px">' + esc(v.lead.name) + '</div><div class="small">' + esc(v.campaign.name || '') + '</div><div class="timer" style="margin:16px 0" >' + dur(v.timer.elapsed, true) + ' waiting</div></div><button class="btn btn-primary btn-full" data-act="ackNow" data-v="' + esc(token) + '">Acknowledge</button>');
  }

  function onboarding(step) {
    var dots = '<div class="steps">' + [1, 2, 3].map(function (i) { return '<i class="' + (i <= step ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var inner;
    if (step === 1) inner = '<div class="h2" style="text-align:center">Welcome to Camplo</div><div class="small" style="text-align:center">Tell us about your workspace</div><div class="field"><label>Workspace name</label><input class="input" id="obName" value="' + esc(D.ws.name) + '" /></div><div class="field"><label>Team size</label><select class="select" id="obSize"><option>1–5</option><option selected>6–15</option><option>16–50</option><option>50+</option></select></div><label class="checkbox"><input type="checkbox" id="obStack" checked/> We already use marketing tools (forms, CRM, ads)</label><button class="btn btn-primary btn-full" data-act="ob1">Continue</button>';
    else if (step === 2) inner = '<div class="h2" style="text-align:center">Connect your first tool</div><div class="small" style="text-align:center">Camplo starts where the lead is born. Point a form or CRM at Camplo.</div>' + ['tally', 'gohighlevel', 'systeme_io', 'twenty_crm'].map(function (p) { return '<div class="setting-row"><b>' + ({ tally: 'Tally', gohighlevel: 'GoHighLevel', systeme_io: 'Systeme.io', twenty_crm: 'Twenty CRM' }[p]) + '</b><button class="btn btn-ghost btn-sm" data-act="connectInt" data-v="' + p + '">Connect</button></div>'; }).join('') + '<button class="btn btn-primary btn-full" data-go="onboarding/3">Continue</button><a href="#/onboarding/3" class="small" style="text-align:center">Skip for now</a>';
    else inner = '<div class="h2" style="text-align:center">Upload your first page or invite your team</div><div class="small" style="text-align:center">Either one starts the watchtower.</div><button class="btn btn-ghost btn-full" data-act="upload">' + ic('upload', 15) + ' Upload a page (ZIP)</button><button class="btn btn-ghost btn-full" data-act="invite">Invite your team</button><button class="btn btn-primary btn-full" data-act="finishSetup">Open Camplo</button>';
    return authWrap(dots + inner);
  }

  function mobileFeed() {
    return '<div class="page" style="max-width:640px"><div class="spread"><div class="h2">Feed</div>' + (D.live.overdueCount ? '<span class="badge b-red b-bold">' + D.live.overdueCount + ' overdue</span>' : '') + '</div><div class="feed">' + sortInsights(D.insights).map(function (i, x) { return insightCard(i, x); }).join('') + '</div>' +
      '<button class="btn btn-ghost btn-full" style="margin-top:16px" data-act="refreshInsights">' + ic('refresh', 14) + ' Refresh</button></div>';
  }

  // ================================================================ overlays
  function closeOverlay() { overlay.innerHTML = ''; S.chatOpen = false; document.removeEventListener('keydown', escClose); }
  function escClose(e) { if (e.key === 'Escape') closeOverlay(); }
  function openOverlay(html) { overlay.innerHTML = '<div class="scrim" data-act="close"></div>' + html; document.addEventListener('keydown', escClose); tick(); tickSlow(); }
  function modal(title, body, foot) { return '<div class="modal" role="dialog"><div class="modal-head"><div class="h2">' + title + '</div><button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div>' + body + (foot ? '<div class="modal-foot">' + foot + '</div>' : '') + '</div>'; }
  function drawer(cls, head, body) { return '<aside class="drawer ' + cls + '"><div class="drawer-head">' + head + '<button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div><div class="drawer-body">' + body + '</div></aside>'; }
  function popover(html, anchor, width) {
    var r = anchor.getBoundingClientRect();
    var left = Math.min(window.innerWidth - width - 12, Math.max(12, r.right - width));
    overlay.innerHTML = '<div class="scrim" style="background:transparent;backdrop-filter:none" data-act="close"></div><div class="popover" style="top:' + (r.bottom + 8) + 'px;left:' + left + 'px;width:' + width + 'px;max-height:70vh;overflow:auto">' + html + '</div>';
    document.addEventListener('keydown', escClose); tickSlow();
  }
  /** Drawers that load data re-render themselves when data arrives. */
  var liveDrawer = null;
  function openLive(fn) { liveDrawer = fn; openOverlay(fn()); }
  var _render = render;
  render = function (soft) { _render(soft); if (soft && liveDrawer && overlay.querySelector('.drawer') && !S.chatOpen) { overlay.innerHTML = '<div class="scrim" data-act="close"></div>' + liveDrawer(); tick(); tickSlow(); } };

  function lifecycleDrawer(id) {
    var l = byId(D.leads, id) || C['lead:' + id];
    var lc = lazy('lead:life:' + id, '/leads/' + id + '/lifecycle');
    return drawer('', '<div><div class="h3">Lifecycle — ' + esc(l ? l.name : '') + '</div><div class="row" style="margin-top:8px">' + (l && l.campaign ? '<span class="chip chip-blue">' + esc(l.campaignName) + '</span>' : '') + (l ? (l.respondedAt ? '<span class="badge b-green">Responded</span>' : '<span class="badge b-red">Not responded</span>') : '') + '</div></div>',
      (!lc ? skel(3) : lc.__error ? errBox(lc) : timeline(lc) + (lc.some(function (e) { return e.source !== 'camplo'; }) ? '' : '<div class="small" style="margin-top:16px">No external lifecycle events yet. Connect a CRM to see the full lead journey. <a href="#/settings/integrations" data-link>Connect</a></div>')) +
      '<div class="row gap16" style="margin-top:24px"><span class="row ts"><span class="dot b"></span>Camplo</span><span class="row ts"><span class="dot" style="background:#A855F7"></span>External</span><span class="row ts"><span class="dot o"></span>Milestone</span></div>' +
      '<a class="btn btn-ghost" style="margin-top:24px" href="#/leads/' + id + '" data-link>Open Lead Dossier</a>');
  }

  function memberDrawer(id) {
    var m = lazy('member:' + id, '/team/members/' + id);
    var u = byId(D.team, id) || {};
    if (!m) return drawer('', '<div class="h2">' + esc(u.name || '') + '</div>', skel(4));
    if (m.__error) return drawer('', '<div class="h2">' + esc(u.name || '') + '</div>', errBox(m));
    var p = m.performance;
    var week = p.avgThisWeekMs, month = p.avg30dMs;
    return drawer('', '<div class="row gap12">' + av(id, 64) + '<div><div class="h2">' + esc(m.name) + '</div><div class="small">' + esc(m.email) + '</div><span class="badge nodot b-blue" style="margin-top:6px">' + m.role.toUpperCase() + '</span></div></div>',
      '<div class="label">Response performance</div><dl class="kv" style="grid-template-columns:1fr auto"><dt>Avg response this week</dt><dd class="' + (week != null && month != null && week <= month ? 'green' : week != null ? 'red' : '') + '"><b>' + dur(week, true) + '</b></dd><dt>30-day average</dt><dd>' + dur(month, true) + '</dd><dt>Acknowledgment rate</dt><dd>' + (p.acknowledgmentRate == null ? '—' : Math.round(p.acknowledgmentRate * 100) + '%') + '</dd><dt>SLA breaches this week</dt><dd class="' + (p.breachesThisWeek ? 'red' : 'green') + '">' + p.breachesThisWeek + '</dd><dt>Fastest response this week</dt><dd class="green">' + dur(p.fastestThisWeekMs, true) + '</dd></dl>' +
      '<div class="label" style="margin-top:24px">Active campaigns</div><div class="row wrap" style="margin-top:8px">' + (m.campaigns.length ? m.campaigns.map(function (c) { return '<a class="chip chip-blue" href="#/campaigns/' + c.id + '/overview" data-link>' + esc(c.name) + '</a>'; }).join('') : '<span class="small">None</span>') + '</div>' +
      '<div class="label" style="margin-top:24px">Recent activity</div>' + (m.recentActivity.length ? m.recentActivity.map(function (a) { return '<div class="log"><span class="mono">' + clock(ms(a.at)) + '</span><span>' + esc(a.description) + '</span></div>'; }).join('') : '<div class="small">No activity yet.</div>') +
      (isOwner() && m.role !== 'owner' ? '<div class="row" style="margin-top:24px"><button class="btn btn-ghost" data-act="editRole" data-id="' + id + '">Edit Role</button><button class="btn btn-danger" data-act="removeMember" data-id="' + id + '">Remove Member</button></div>' : ''));
  }

  // ---------------------------------------------------------------- AI chat (Screen 14)
  function chatPanel() {
    var h = C['chat'];
    var msgs = '';
    if (!h) msgs = '<div class="investigating"><div class="brain-ico think" style="width:24px;height:24px">' + ic('brain', 13) + '</div>Loading conversation…</div>';
    else if (h.__error) msgs = h.__status === 403 ? '<div class="card"><div class="small">AI Chat is available on Growth.</div><div style="margin-top:10px">' + planChip('growth') + '</div></div>' : errBox(h);
    else {
      var lastDay = '';
      h.messages.forEach(function (m) {
        var d = dayLabel(ms(m.createdAt));
        if (d !== lastDay) { msgs += '<div class="date-sep">' + d + '</div>'; lastDay = d; }
        msgs += m.role === 'user' ? '<div class="msg-u">' + esc(m.content) + '</div>' : '<div class="msg-a">' + ic('brain', 18) + '<div>' + md(m.content) + '</div></div>';
      });
      if (S.chatPending) msgs += '<div class="investigating"><div class="brain-ico think" style="width:24px;height:24px">' + ic('brain', 13) + '</div>Investigating your campaigns…</div>';
      if (!h.messages.length) {
        var sugg = C['chat:sugg'] || [];
        msgs += '<div class="col gap12" style="margin-top:8px">' + sugg.map(function (p) { return '<button class="prompt-chip" data-act="ask" data-q="' + esc(p) + '">' + esc(p) + '</button>'; }).join('') + '</div>';
      }
      if (h.capacity && h.capacity.limitReached) msgs += '<div class="banner amber">You\'ve reached the advanced intelligence included in your plan. Continue with standard intelligence, <a href="#" data-act="upgrade" data-plan="watchtower">upgrade your plan</a>, or <a href="#/settings/ai" data-link>connect your own API key</a>.</div>';
      else if (h.capacity && h.capacity.warning) msgs += '<div class="banner amber">You\'re approaching your plan\'s advanced intelligence limit.</div>';
    }
    var depths = [['Economy', 'fast, lower capacity usage'], ['Standard', 'balanced'], ['Deep', 'stronger reasoning'], ['Frontier', 'highest intelligence']];
    var limit = h && h.capacity && h.capacity.limitReached;
    var depthOk = h && h.depthSelector;
    return '<aside class="drawer w400" id="chatPanel"><div class="drawer-head"><div class="row gap12"><div class="brain-ico">' + ic('brain', 18) + '</div><div><div class="h3">Camplo Intelligence</div><div class="ts italic">Aware of everything in your workspace</div></div></div><div class="row"><button class="close tip" data-tip="Clear conversation" data-act="clearChat">' + ic('more', 16) + '</button><button class="close" data-act="close">' + ic('x', 18) + '</button></div></div>' +
      '<div class="chat" id="chatScroll">' + msgs + '</div>' +
      (h && !h.__error ? '<div class="chat-input">' + (depthOk ? '<button class="linkbtn" style="align-self:flex-start;font-size:12px;color:var(--text-muted)" data-act="depth">' + (S.depthOpen ? '▾' : '▸') + ' Choose depth · ' + S.depth + '</button>' : '') +
        (S.depthOpen && depthOk ? '<div class="radio-group">' + depths.map(function (d) { var dis = limit && (d[0] === 'Deep' || d[0] === 'Frontier'); return '<span class="radio ' + (S.depth === d[0] ? 'on' : '') + '" ' + (dis ? 'style="opacity:.4" title="Advanced intelligence limit reached for this period."' : 'data-act="setDepth" data-v="' + d[0] + '"') + ' ><i></i>' + d[0] + '</span>'; }).join('') + '</div>' + (S.depth === 'Deep' || S.depth === 'Frontier' ? '<div class="ts italic">Uses more AI capacity</div>' : '') : '') +
        '<div class="chat-box"><textarea class="input" id="chatInput" placeholder="Ask Camplo anything..." rows="2" ' + (S.chatPending ? 'disabled' : '') + '></textarea><button class="send" id="chatSend" data-act="send" disabled aria-label="Send">' + ic('send', 16) + '</button></div></div>' : '') + '</aside>';
  }
  function refreshChat() {
    if (!S.chatOpen) return;
    var draft = document.getElementById('chatInput');
    var val = draft ? draft.value : '';
    overlay.innerHTML = '<div class="scrim" data-act="close" style="background:rgba(5,5,8,0.3)"></div>' + chatPanel();
    var sc = document.getElementById('chatScroll'); if (sc) sc.scrollTop = sc.scrollHeight;
    var inp = document.getElementById('chatInput');
    if (inp) { inp.value = val; document.getElementById('chatSend').disabled = !val.trim(); if (window.innerWidth > 900 && !S.chatPending) inp.focus(); }
  }
  function openChat() {
    S.chatOpen = true; liveDrawer = null;
    document.addEventListener('keydown', escClose);
    if (!C['chat']) {
      api('/chat/history').then(function (h) { C['chat'] = h; if (!h.messages.length) return api('/chat/suggestions').then(function (s) { C['chat:sugg'] = s; }); }, function (e) { C['chat'] = { __error: e.message, __status: e.status }; })
        .then(function () { refreshChat(); });
    }
    refreshChat();
  }
  function ask(q) {
    q = (q || '').trim();
    if (!q || S.chatPending || !C['chat'] || C['chat'].__error) return;
    C['chat'].messages.push({ role: 'user', content: q, createdAt: new Date().toISOString() });
    S.chatPending = true; refreshChat();
    var inp = document.getElementById('chatInput'); if (inp) inp.value = '';
    api('/chat/message', { method: 'POST', body: { content: q, depth: S.depth } }).then(function (m) {
      C['chat'].messages.push(m);
    }, function (e) {
      C['chat'].messages.push({ role: 'assistant', content: e.message, createdAt: new Date().toISOString() });
    }).then(function () { S.chatPending = false; refreshChat(); });
  }

  // ---------------------------------------------------------------- modals
  function newCampaignModal() {
    return modal('New campaign', '<div class="col gap16">' +
      '<div class="field"><label>Campaign name</label><input class="input" id="ncName" maxlength="100" placeholder="e.g. Christmas Hampers 2026" /><span class="errmsg hidden" id="ncErr">Give the campaign a name.</span></div>' +
      '<div class="field"><label>Description</label><textarea class="input" id="ncDesc" placeholder="What is this campaign, and what does success look like?"></textarea></div>' +
      '<div class="form-grid"><div class="field"><label>Owner</label><input class="input" value="' + esc(D.me.name) + '" disabled /></div><div class="field"><label>Start date</label><input class="input" type="date" id="ncDate" value="' + new Date().toISOString().slice(0, 10) + '" /></div></div>' +
      (planOk('growth') ? '<div class="form-grid"><div class="field"><label>Budget (optional)</label><div class="row"><select class="select" id="ncCur" style="width:100px"><option value="USD">$ USD</option><option value="NGN">₦ NGN</option><option value="GBP">£ GBP</option><option value="EUR">€ EUR</option><option value="KES">KES</option><option value="GHS">GHS</option><option value="ZAR">ZAR</option></select><input class="input" id="ncBudget" type="number" min="0" placeholder="0" /></div></div><div class="field"><label>Alert when CPL exceeds (optional)</label><input class="input" id="ncCpl" type="number" min="0" placeholder="CPL threshold" /></div></div>' : '') + '</div>',
      '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="createCampaign">Create Campaign</button>');
  }
  function uploadModal() {
    var step = S.uploadStep;
    var steps = '<div class="steps">' + [1, 2, 3, 4].map(function (i) { return '<i class="' + (i <= step ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var body, foot = '';
    if (step === 1) body = '<label class="dropzone" id="dropzone">' + ic('upload', 32) + '<div class="h3" style="margin-top:12px">Drop your page ZIP here</div><div class="small">or click to browse · index.html inside · max 100 MB</div><input type="file" accept=".zip,application/zip" hidden data-act-change="zip"/></label><span class="errmsg hidden" id="upErr"></span>';
    else if (step === 2) body = '<div class="small" style="margin-bottom:8px">Deploying your site…</div><div class="progress"><i id="upProg" style="width:40%"></i></div>' + (S.entryPoints ? '<div class="field" style="margin-top:16px"><label>Multiple entry files found — choose one</label><select class="select" id="upEntry">' + S.entryPoints.map(function (e) { return '<option>' + esc(e) + '</option>'; }).join('') + '</select><button class="btn btn-primary" style="margin-top:12px" data-act="uploadEntry">Continue</button></div>' : '');
    else if (step === 3) {
      body = '<div class="col gap16"><div class="field"><label>Page name</label><input class="input" id="upName" value="' + esc(S.uploadName || '') + '" /></div><div class="field"><label>Campaign</label><select class="select" id="upCamp" ' + (S.uploadCampLocked ? 'disabled' : '') + '><option value="">No campaign</option>' + D.campaigns.filter(function (c) { return c.status !== 'COMPLETE'; }).map(function (c) { return '<option value="' + c.id + '"' + (S.uploadCamp === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div><div class="field"><label>Address</label><div class="row"><input class="input mono" id="upSlug" value="' + esc((S.uploadName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '" /><span class="mono">.' + esc(D.pages[0] ? D.pages[0].host.split('.').slice(1).join('.') : 'camplo.app') + '</span></div></div></div>';
      foot = '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="uploadSave">Deploy</button>';
    } else {
      var p = byId(D.pages, S.uploadId);
      body = '<div class="empty" style="padding:24px"><div class="check-big">' + ic('check', 28) + '</div><div class="h">Page deployed</div>' + (p ? '<p class="mono">' + esc(p.url) + '</p><p class="small">Its signed webhook is live. Camplo watches the first 72 hours closely.</p>' : '') + '</div>';
      foot = (p ? '<a class="btn btn-ghost" href="' + esc(p.url) + '" target="_blank" rel="noopener">View Page</a><button class="btn btn-primary" data-act="closeGo" data-v="' + (p.camp ? 'campaigns/' + p.camp + '/pages' : 'pages') + '">' + (p.camp ? 'Go to Campaign' : 'Go to Pages') + '</button>' : '<button class="btn btn-primary" data-act="close">Done</button>');
    }
    return modal(S.redeployId ? 'Upload new version' : 'Upload a new page', steps + body, foot);
  }
  function upgradeModal(target) {
    var price = { growth: 197, watchtower: 347, agency: 597 }[target] || 347;
    var bullets = { growth: ['AI Chat and the Morning Intelligence Brief', 'UTM attribution, Health Pulse and 72-hour early warning', 'Budget tracking with CPL alerts and one connected tool'], watchtower: ['Diagnostic and strategic recommendations with full campaign memory', 'Cross-tool SLA monitoring and unlimited connected tools', 'Auto-generated Campaign Retrospectives with branded PDF'], agency: ['White-label retrospectives with your logo only', 'Client sub-accounts', 'Everything in Watchtower'] }[target] || [];
    return modal('Upgrade to ' + cap(target), '<div class="row gap12"><span class="chip">Current: ' + cap(D.plan) + '</span>' + ic('chev', 14) + '<span class="chip chip-blue">' + cap(target) + '</span></div><ul class="small" style="line-height:1.9;margin:20px 0 0;padding-left:18px">' + bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul><span class="errmsg hidden" id="upgErr"></span>',
      '<button class="linkbtn" data-act="close" style="margin-right:auto;color:var(--text-muted)">Maybe later</button>' + (target === 'agency' ? '<button class="btn btn-primary disabled" disabled>Agency plan arrives in v2</button>' : '<button class="btn btn-primary" data-act="doUpgrade" data-plan="' + target + '">Upgrade to ' + cap(target) + ' — $' + price + '/month</button>'));
  }

  // ================================================================ toast
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = '<span class="' + (type === 'error' ? 'red' : type === 'info' ? 'blue' : 'green') + '">' + ic(type === 'error' ? 'x' : type === 'info' ? 'brain' : 'check', 15) + '</span>' + esc(msg);
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 220); }, 3000);
  }
  function fail(e) { toast(e.message || String(e), 'error'); }
  function busy(el, label) { if (!el) return function () {}; var prev = el.innerHTML; el.disabled = true; el.classList.add('loading'); el.innerHTML = '<span class="spinner"></span>' + (label ? ' ' + label : ''); return function () { el.disabled = false; el.classList.remove('loading'); el.innerHTML = prev; }; }

  // ================================================================ live timers
  function tick() {
    var now = Date.now();
    var els = document.querySelectorAll('[data-since]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], since = +el.getAttribute('data-since'), stop = +el.getAttribute('data-stop') || 0;
      var msv = (stop || now) - since;
      el.textContent = dur(msv, true);
      var thr = +el.getAttribute('data-thr');
      if (thr) {
        var s = msv / 1000;
        el.classList.remove('green', 'amber', 'red', 'breach');
        el.classList.add(s < thr * 0.75 ? 'green' : s < thr ? 'amber' : 'red');
        if (s >= thr && !stop) el.classList.add('breach');
      }
    }
    var us = document.querySelectorAll('[data-until]');
    for (var j = 0; j < us.length; j++) {
      var left = +us[j].getAttribute('data-until') - now;
      us[j].textContent = left > 0 ? (us[j].getAttribute('data-prefix') || '') + dur(left).replace(/ \d+s$/, '') : '';
    }
  }
  function tickSlow() { var els = document.querySelectorAll('[data-ago]'); for (var i = 0; i < els.length; i++) els[i].textContent = ago(+els[i].getAttribute('data-ago') || 0); }
  setInterval(tick, 1000);
  setInterval(tickSlow, 30000);

  // Team notes: mark read when they scroll into view (IntersectionObserver).
  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var el = en.target;
      if (!en.isIntersecting || el.getAttribute('data-unread') !== '1') return;
      el.setAttribute('data-unread', '0');
      var id = el.getAttribute('data-teamnote');
      var t = byId(D.teamNotes, id); if (t) t.unread = false;
      el.style.borderLeft = '';
      api('/team-notes/' + id + '/read', { method: 'POST' }).catch(function () {});
    });
  }, { threshold: 0.6 }) : null;
  new MutationObserver(function () { if (io) document.querySelectorAll('[data-teamnote][data-unread="1"]').forEach(function (n) { io.observe(n); }); }).observe(app, { childList: true, subtree: true });

  // ================================================================ search
  var searchTimer = null, searchSeq = 0;
  function searchResults(q) {
    clearTimeout(searchTimer);
    var box = document.getElementById('searchBox');
    if (q.trim().length < 2) { if (box) box.remove(); return; }
    searchTimer = setTimeout(function () {
      var seq = ++searchSeq;
      api('/search?q=' + encodeURIComponent(q.trim())).then(function (r) {
        if (seq !== searchSeq) return;
        var rows = r.campaigns.map(function (c) { return ['CAMPAIGNS', c.name, cap(c.status), 'campaigns/' + c.id + '/overview', 'target']; })
          .concat(r.leads.map(function (l) { return ['LEADS', l.name, l.displayId + ' · ' + (l.campaignName || ''), 'leads/' + l.id, 'inbox']; }))
          .concat(r.pages.map(function (p) { return ['PAGES', p.name, p.host, 'pages', 'file']; }));
        var re = new RegExp('(' + q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
        var html = '', last = '';
        rows.forEach(function (x, i) { if (x[0] !== last) { html += '<div class="label">' + x[0] + '</div>'; last = x[0]; } html += '<div class="sr-item' + (i === 0 ? ' sel' : '') + '" data-go="' + x[3] + '">' + ic(x[4], 15) + '<div class="grow"><div style="font-size:13px">' + esc(x[1]).replace(re, '<b>$1</b>') + '</div><div class="ts">' + esc(x[2]) + '</div></div>' + ic('chev', 12) + '</div>'; });
        if (!rows.length) html = '<div class="empty" style="padding:24px"><p class="muted">No results for \'' + esc(q) + '\'.</p></div>';
        box = document.getElementById('searchBox');
        if (!box) { box = document.createElement('div'); box.id = 'searchBox'; box.className = 'search-results'; var s = document.getElementById('search'); if (!s) return; s.appendChild(box); }
        box.innerHTML = html;
      }, function () {});
    }, 300);
  }

  // ================================================================ events
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'searchInput') searchResults(t.value);
    if (t.id === 'noteInput') document.getElementById('postNote').disabled = !t.value.trim();
    if (t.id === 'chatInput') document.getElementById('chatSend').disabled = !t.value.trim();
    if (t.id === 'pageSearch') { S.pageQuery = t.value; clearTimeout(S.pst); S.pst = setTimeout(function () { render(true); var el = document.getElementById('pageSearch'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 250); }
  });
  document.addEventListener('focusout', function (e) { if (e.target.id === 'searchInput') setTimeout(function () { var b = document.getElementById('searchBox'); if (b) b.remove(); }, 180); });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { var s = document.getElementById('searchInput'); if (s) { e.preventDefault(); s.focus(); } }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      if (e.target.id === 'noteInput') document.getElementById('postNote').click();
      if (e.target.id === 'chatInput') ask(e.target.value);
    }
    if (e.target.id === 'searchInput') {
      var items = Array.prototype.slice.call(document.querySelectorAll('.sr-item')), idx = items.findIndex(function (x) { return x.classList.contains('sel'); });
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; if (items[idx]) items[idx].classList.remove('sel'); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[idx].classList.add('sel'); }
      if (e.key === 'Enter' && items[idx]) { go(items[idx].getAttribute('data-go')); e.target.blur(); }
      if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); }
    }
  });

  document.addEventListener('submit', function (e) {
    var f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    var kind = f.getAttribute('data-form'), data = Object.fromEntries(new FormData(f));
    var btn = f.querySelector('button[type=submit]'), done = busy(btn);
    var err = function (m) { done(); var el = document.getElementById('formErr'); if (el) { el.textContent = m; el.classList.remove('hidden'); } else toast(m, 'error'); };
    if (kind === 'login') {
      api('/auth/login', { method: 'POST', body: { email: data.email, password: data.password } }).then(function (r) {
        S.flash = null; C = {};
        if (r.next === '/pending') { go('pending'); return; }
        D = null; go(r.next === '/setup' ? 'onboarding/1' : 'dashboard');
      }, function (x) { err(x.message); });
    } else if (kind === 'signup') {
      api('/auth/signup', { method: 'POST', body: data }).then(function (r) {
        if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
        if (r.next === '/login') { S.flash = 'Workspace created — sign in to continue.'; go('login'); } else go('pending');
      }, function (x) { err(x.message); });
    } else if (kind === 'forgot') {
      api('/auth/forgot-password', { method: 'POST', body: { email: data.email } }).then(function () { S.forgotSent = data.email; render(); }, function (x) { err(x.message); });
    } else if (kind === 'reset') {
      if (data.p1 !== data.p2) { err('Passwords do not match.'); return; }
      api('/auth/reset-password', { method: 'POST', body: { token: data.token, newPassword: data.p1 } }).then(function () { S.resetDone = true; render(); }, function (x) { err(x.message); });
    } else if (kind === 'accept') {
      api('/team/invitations/accept', { method: 'POST', body: { token: data.token, password: data.password, name: data.name || undefined } }).then(function () { D = null; go('dashboard'); }, function (x) { err(x.message); });
    }
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-filter')) {
      S.leadFilter[t.getAttribute('data-filter')] = t.value;
      render(true);
    }
    if (t.hasAttribute('data-pfilter')) { S[t.getAttribute('data-pfilter')] = t.value; render(true); }
    var act = t.getAttribute('data-act-change');
    if (act === 'reassign' && t.value) {
      var id = t.getAttribute('data-id');
      api('/leads/' + id + '/assign', { method: 'POST', body: { assigneeId: t.value } }).then(function () {
        toast('Assigned to ' + user(t.value).name + ' — they have been notified'); inval('lead:'); reload(true);
      }, fail);
    }
    if (act === 'zip' && t.files[0]) uploadZip(t.files[0]);
    if (act === 'logo' && t.files[0]) {
      var fd = new FormData(); fd.append('file', t.files[0]);
      api('/workspace/logo', { method: 'POST', body: fd }).then(function () { toast('Logo updated'); reload(true); }, fail);
    }
    if (act === 'pageVip') api('/pages/' + t.getAttribute('data-id'), { method: 'PATCH', body: { vip: t.checked } }).then(function () { toast('VIP rule updated'); reload(true); }, fail);
  });

  function uploadZip(file, entry) {
    var err = document.getElementById('upErr');
    if (!/\.zip$/i.test(file.name)) { if (err) { err.textContent = 'Only .zip files can be uploaded.'; err.classList.remove('hidden'); } return; }
    if (file.size > 100 * 1024 * 1024) { if (err) { err.textContent = 'File exceeds 100MB limit'; err.classList.remove('hidden'); } return; }
    S.uploadFile = file; S.uploadStep = 2; S.entryPoints = null; openOverlay(uploadModal());
    var fd = new FormData(); fd.append('file', file);
    if (entry) fd.append('entryFile', entry);
    var p;
    if (S.redeployId) p = api('/pages/' + S.redeployId + '/redeploy', { method: 'POST', body: fd });
    else { fd.append('name', file.name.replace(/\.zip$/i, '')); if (S.uploadCamp) fd.append('campaignId', S.uploadCamp); p = api('/pages/upload', { method: 'POST', body: fd }); }
    p.then(function (r) {
      if (r.status === 'needs_input') { S.entryPoints = r.entry_points; openOverlay(uploadModal()); return; }
      var bar = document.getElementById('upProg'); if (bar) bar.style.width = '100%';
      if (S.redeployId) { toast('Redeployed successfully'); S.redeployId = null; closeOverlay(); reload(true); return; }
      S.uploadId = r.id; S.uploadName = file.name.replace(/\.zip$/i, '');
      return loadCore().then(function () { S.uploadStep = 3; openOverlay(uploadModal()); });
    }, function (x) { S.uploadStep = 1; openOverlay(uploadModal()); var el = document.getElementById('upErr'); if (el) { el.textContent = x.message; el.classList.remove('hidden'); } });
  }

  function reauthAfterMutation(p, msg) { return p.then(function (r) { if (msg) toast(msg); reload(true); return r; }, function (e) { fail(e); throw e; }); }

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act],[data-go],[data-cmd],a[data-link]');
    if (!el) return;
    if (el.hasAttribute('data-cmd')) { e.preventDefault(); var cmd = el.getAttribute('data-cmd'); document.execCommand(cmd, false, cmd === 'hiliteColor' ? '#1A2560' : cmd === 'createLink' ? prompt('Link URL (https://…)', 'https://') : null); return; }
    if (el.matches('a[data-link]')) { closeOverlay(); return; }
    var act = el.getAttribute('data-act');
    if (!act && el.hasAttribute('data-go')) { e.preventDefault(); closeOverlay(); go(el.getAttribute('data-go')); return; }
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    var id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    if (act && el.closest('tr[data-go]') && act !== 'pageDrawer') e.stopPropagation();
    var done;
    switch (act) {
      case 'close': closeOverlay(); liveDrawer = null; break;
      case 'closeGo': closeOverlay(); go(v); break;
      case 'theme':
        var light = document.documentElement.getAttribute('data-theme') !== 'light';
        document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark'); store('camplo-theme', light ? 'light' : 'dark');
        api('/auth/me', { method: 'PATCH', body: { theme: light ? 'light' : 'dark' } }).catch(function () {});
        var dk = document.querySelector('.dock'); if (dk) dk.outerHTML = dock(); break;
      case 'hideStack': S.stackBannerHidden = true; render(true); break;
      case 'fillDemo': S.demo = true; render(); break;
      case 'chat': openChat(); break;
      case 'ask': ask(el.getAttribute('data-q')); break;
      case 'send': ask(document.getElementById('chatInput').value); break;
      case 'depth': S.depthOpen = !S.depthOpen; refreshChat(); break;
      case 'setDepth': S.depth = v; refreshChat(); break;
      case 'clearChat':
        if (confirm('This will permanently clear your conversation history. Are you sure?')) api('/chat/history', { method: 'DELETE' }).then(function () { delete C['chat']; openChat(); }, fail);
        break;
      case 'dismissBrief': S.briefDismissed = true; store('camplo-brief', new Date().toDateString()); render(true); break;
      case 'insight':
        var ins = byId(D.insights, id);
        openOverlay(modal(ins.priority ? '<span class="red">Priority Flag</span>' : 'Insight', '<div style="font:600 18px/1.4 var(--f-display)">' + esc(ins.obs) + '</div><p class="small" style="font-size:14px;line-height:1.7">' + esc(ins.ev || '') + '</p><div class="row" style="margin-top:16px">' + (ins.tag ? '<span class="chip chip-blue">' + esc(ins.tag) + '</span>' : '') + '<span class="ts">' + new Date(ins.t).toLocaleString('en-GB') + '</span></div>', ins.camp ? '<button class="btn btn-ghost" data-act="close">Close</button><button class="btn btn-primary" data-act="closeGo" data-v="campaigns/' + ins.camp + '/insights">Open campaign insights</button>' : ''));
        break;
      case 'dismissInsight':
        D.insights = D.insights.filter(function (i) { return i.id !== id; }); render(true);
        api('/insights/' + id + '/dismiss', { method: 'POST' }).catch(function (x) { fail(x); reload(true); });
        break;
      case 'refreshInsights':
        S.refreshing = true; render(true);
        api('/insights/refresh', { method: 'POST' }).then(function (r) {
          S.refreshing = false;
          if (!r.refreshed) toast('Just refreshed. Check back in ' + r.retryInMinutes + ' minutes.', 'info');
          else toast('Intelligence refreshed — ' + (r.level1 + (r.recommendations || 0)) + ' new signals', 'info');
          inval('camp:recs'); reload(true);
        }, function (x) { S.refreshing = false; fail(x); render(true); });
        break;
      case 'collapse': el.classList.toggle('open'); el.nextElementSibling.classList.toggle('open'); break;
      case 'recExpand':
        var rec = byId(D.recs.map(function (r) { return Object.assign({ id: r.recommendation_id }, r); }), id) || findRec(id);
        openOverlay('<div class="modal" style="width:min(720px,calc(100vw - 32px))"><div class="modal-head"><div class="h2">Recommendation</div><button class="close" data-act="close">' + ic('x', 18) + '</button></div>' + recCard(rec, 0, true) + '</div>');
        break;
      case 'memory':
        var r0 = findRec(id);
        openOverlay(modal('Based on campaign history', '<ul class="timeline" style="margin-top:0">' + (r0.memory_timeline || []).map(function (m) { return '<li style="grid-template-columns:70px 30px 1fr auto"><span class="t">' + new Date(m.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + '</span><span class="tdot c"></span><span>' + esc(m.text) + '</span><span class="badge nodot ' + (m.kind === 'dismissed' ? 'b-grey' : 'b-green') + '">' + esc(m.kind) + '</span></li>'; }).join('') + '</ul><p class="small" style="margin-top:16px">Camplo checks what was already tried on this campaign — and the measured outcome — before recommending anything.</p>'));
        break;
      case 'dismissRec':
        var card = document.getElementById('rec-' + id);
        if (card) { card.style.transition = 'all 250ms'; card.style.opacity = 0; card.style.transform = 'translateX(24px)'; }
        api('/recommendations/' + id + '/dismiss', { method: 'POST' }).then(function () {
          toast('Recommendation dismissed — Camplo will remember that', 'info'); closeOverlay(); inval('camp:recs'); reload(true);
        }, fail);
        break;
      case 'respond':
        done = busy(el, 'Responding...');
        api('/leads/' + id + '/respond', { method: 'POST' }).then(function (l) {
          el.classList.remove('loading'); el.classList.add('success'); el.innerHTML = ic('check', 14) + ' Responded';
          var m = mapLead(l), i = D.leads.findIndex(function (x) { return x.id === id; });
          if (i >= 0) D.leads[i] = m;
          C['lead:' + id] = m; inval('lead:audit:' + id); inval('lead:life:' + id); inval('camp:leads');
          setTimeout(function () { reload(true); }, 1500);
        }, function (x) { if (x.status === 409) { inval('lead:'); reload(true); return; } done(); toast('Could not mark as responded. Try again.', 'error'); });
        break;
      case 'assignPicker':
        var lead = byId(D.leads, id) || (C['camp:leads:' + (route().parts[1])] || { list: [] }).list.filter(function (x) { return x.id === id; })[0];
        popover('<div class="label" style="padding:8px 12px">' + (lead && lead.assignee ? 'Reassign to' : 'Assign to') + '</div>' + D.team.filter(function (u) { return !lead || u.id !== lead.assignee; }).map(function (u) { return '<div class="menu-item" data-act="doAssign" data-id="' + id + '" data-v="' + u.id + '">' + av(u.id, 24) + esc(u.name) + '</div>'; }).join(''), el, 240);
        break;
      case 'doAssign':
        closeOverlay();
        api('/leads/' + id + '/assign', { method: 'POST', body: { assigneeId: v } }).then(function () { toast('Assigned to ' + user(v).name); inval('lead:'); inval('camp:leads'); reload(true); }, fail);
        break;
      case 'lifecycle': openLive(function () { return lifecycleDrawer(id); }); break;
      case 'clearFilters': S.leadFilter = { status: 'all', campaign: 'all', assignee: 'all', sort: 'newest' }; if (location.hash.indexOf('?') >= 0) go('leads'); else render(true); break;
      case 'loadMore':
        done = busy(el);
        var camId = el.closest('[data-camp]') && el.closest('[data-camp]').getAttribute('data-camp');
        var src = camId ? C['camp:leads:' + camId].list : D.leads;
        var oldest = src.reduce(function (m, l) { return Math.min(m, l.arrived); }, Infinity);
        api((camId ? '/campaigns/' + camId + '/leads' : '/leads') + '?limit=200&cursor=' + encodeURIComponent(new Date(oldest).toISOString())).then(function (r) {
          r.leads.map(mapLead).forEach(function (l) { src.push(l); });
          if (camId) C['camp:leads:' + camId].more = r.has_more; else D.leadsEnv.has_more = r.has_more;
          render(true);
        }, function (x) { done(); fail(x); });
        break;
      case 'newCampaign': openOverlay(newCampaignModal()); break;
      case 'createCampaign':
        var nm = document.getElementById('ncName');
        if (!nm.value.trim()) { nm.classList.add('err'); document.getElementById('ncErr').classList.remove('hidden'); nm.focus(); break; }
        var bud = document.getElementById('ncBudget'), cpl = document.getElementById('ncCpl');
        done = busy(el);
        api('/campaigns', { method: 'POST', body: {
          name: nm.value.trim(), description: document.getElementById('ncDesc').value ? '<p>' + esc(document.getElementById('ncDesc').value) + '</p>' : null, startDate: document.getElementById('ncDate').value,
          budget: bud && bud.value ? +bud.value : null, cplThreshold: cpl && cpl.value && bud && bud.value ? +cpl.value : null, currency: document.getElementById('ncCur') ? document.getElementById('ncCur').value : 'USD',
        } }).then(function (c) { closeOverlay(); toast('Campaign created'); return loadCore().then(function () { go('campaigns/' + c.id + '/overview'); }); }, function (x) { done(); if (x.data && x.data.reason === 'plan_limit') openOverlay(upgradeModal(x.data.plan)); else fail(x); });
        break;
      case 'pin':
        api('/campaigns/' + id + '/pin', { method: v === '1' ? 'POST' : 'DELETE' }).then(function () { reload(true); }, fail);
        break;
      case 'renameCampaign':
        var h1 = document.getElementById('campName');
        h1.outerHTML = '<input class="input" id="campNameInput" value="' + esc(camp(id).name) + '" style="font:700 24px var(--f-display);height:44px;max-width:520px" data-id="' + id + '"/>';
        var ni = document.getElementById('campNameInput'); ni.focus(); ni.select();
        var save = function () { var val = ni.value.trim(); if (val && val !== camp(id).name) api('/campaigns/' + id, { method: 'PATCH', body: { name: val } }).then(function () { reload(true); }, fail); else render(true); };
        ni.addEventListener('keydown', function (k) { if (k.key === 'Enter') ni.blur(); if (k.key === 'Escape') { ni.value = camp(id).name; ni.blur(); } });
        ni.addEventListener('blur', save, { once: true });
        break;
      case 'editSpend':
        var val = prompt('Daily spend (' + (camp(id).currency) + ')', camp(id).daily == null ? '' : camp(id).daily);
        if (val != null && val !== '' && !isNaN(+val)) reauthAfterMutation(api('/campaigns/' + id, { method: 'PATCH', body: { dailySpend: +val } }), 'Daily spend updated — logged to campaign memory');
        break;
      case 'logChange':
        openOverlay(modal('Log a campaign change', '<div class="col gap16"><div class="field"><label>What changed?</label><select class="select" id="chType"><option value="budget">Budget</option><option value="audience">Audience</option><option value="creative">Creative</option><option value="messaging">Messaging</option><option value="page">Landing page</option></select></div><div class="field"><label>Describe it</label><input class="input" id="chDesc" placeholder="e.g. Switched hero video to carousel"/></div><div class="small">Camplo snapshots performance now and measures it again in 7 days. Future recommendations reference the outcome.</div></div>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="saveChange" data-id="' + id + '">Log change</button>'));
        break;
      case 'saveChange':
        var d = document.getElementById('chDesc').value.trim();
        if (d.length < 3) { document.getElementById('chDesc').classList.add('err'); break; }
        reauthAfterMutation(api('/campaigns/' + id, { method: 'PATCH', body: { change: { type: document.getElementById('chType').value, description: d } } }), 'Change logged to campaign memory').then(closeOverlay, function () {});
        break;
      case 'markComplete':
        openOverlay(modal('Mark campaign complete?', '<p class="small" style="font-size:14px">This will generate a Campaign Retrospective automatically. This cannot be undone.</p>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="confirmComplete" data-id="' + id + '">Confirm</button>'));
        break;
      case 'confirmComplete':
        done = busy(el);
        api('/campaigns/' + id + '/complete', { method: 'POST' }).then(function () { closeOverlay(); toast('Generating your retrospective…', 'info'); inval('camp:retro:' + id); return loadCore().then(function () { go(planOk('watchtower') ? 'campaigns/' + id + '/retrospective' : 'campaigns/' + id + '/overview'); }); }, function (x) { done(); fail(x); });
        break;
      case 'editOverview': S.editingOverview = true; render(true); break;
      case 'cancelOverview': S.editingOverview = false; render(true); break;
      case 'saveOverview':
        done = busy(el);
        api('/campaigns/' + id, { method: 'PATCH', body: { description: sanitize(document.getElementById('ovEditor').innerHTML) } }).then(function () { S.editingOverview = false; toast('Brief saved'); reload(true); }, function (x) { done(); fail(x); });
        break;
      case 'ifilter': S.insightFilter = v; render(true); break;
      case 'postNote':
        var inp = document.getElementById('noteInput'); if (!inp.value.trim()) break;
        var type = el.getAttribute('data-type'), ent = el.getAttribute('data-entity'), key = el.getAttribute('data-key');
        done = busy(el);
        api((type === 'lead' ? '/leads/' : '/campaigns/') + ent + '/notes', { method: 'POST', body: { content: inp.value.trim() } }).then(function () { toast('Note posted'); delete C[key]; render(true); reload(); }, function (x) { done(); fail(x); });
        break;
      case 'postMeeting':
        var mb = document.getElementById('mnBody');
        if (!mb.value.trim()) { mb.classList.add('err'); break; }
        api('/campaigns/' + id + '/meeting-notes', { method: 'POST', body: { title: document.getElementById('mnTitle').value || null, meetingDate: document.getElementById('mnDate').value ? new Date(document.getElementById('mnDate').value).toISOString() : null, content: mb.value.trim() } })
          .then(function () { toast('Meeting note saved'); delete C['camp:meeting:' + id]; render(true); }, fail);
        break;
      case 'editNote': case 'editTeamNote': S.editNote = id; render(true); break;
      case 'cancelNote': S.editNote = null; render(true); break;
      case 'saveNote':
        var body = document.getElementById('editNoteInput').value;
        api((el.getAttribute('data-team') === '1' ? '/team-notes/' : '/notes/') + id, { method: 'PATCH', body: { content: body } }).then(function () {
          S.editNote = null; toast('Note updated'); inval('camp:notes'); inval('lead:notes'); inval('camp:meeting'); reload(true);
        }, fail);
        break;
      case 'pageDrawer': openLive(function () { return pageDrawer(id); }); break;
      case 'pageMenu':
        e.stopPropagation();
        var pg = byId(D.pages, id);
        popover('<div class="menu-item" data-act="serving" data-id="' + id + '" data-v="archive">Archive</div><div class="menu-item" data-act="domain" data-id="' + id + '">Connect domain</div><div class="menu-item" data-act="movePage" data-id="' + id + '">Move to campaign</div><div class="menu-item" style="' + (pg.rollback ? '' : 'opacity:0.4;pointer-events:none') + '" data-act="rollback" data-id="' + id + '">Rollback</div>' + (isOwner() ? '<div style="height:1px;background:var(--border-subtle);margin:4px 0"></div><div class="menu-item" style="color:var(--status-red)" data-act="deletePage" data-id="' + id + '">Delete…</div>' : ''), el, 200);
        break;
      case 'serving':
        closeOverlay();
        reauthAfterMutation(api('/pages/' + id + '/' + v, { method: 'POST' }), { pause: 'Page paused', unpause: 'Page unpaused', archive: 'Page archived' }[v]);
        break;
      case 'rollback':
        var pr = byId(D.pages, id);
        if (confirm('This will replace the current version with the version deployed on ' + fmtDate(pr.prevAt) + '. Are you sure?')) { closeOverlay(); reauthAfterMutation(api('/pages/' + id + '/rollback', { method: 'POST' }), 'Previous version restored.'); }
        break;
      case 'deletePage':
        closeOverlay();
        openOverlay(modal('Delete page', '<p class="small">Leads from this page are kept permanently. Type <b>DELETE</b> to confirm.</p><input class="input" id="delConfirm"/>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-danger" data-act="confirmDelete" data-id="' + id + '">Confirm Delete</button>'));
        break;
      case 'confirmDelete':
        if (document.getElementById('delConfirm').value !== 'DELETE') { document.getElementById('delConfirm').classList.add('err'); break; }
        reauthAfterMutation(api('/pages/' + id, { method: 'DELETE' }), 'Page deleted').then(closeOverlay, function () {});
        break;
      case 'movePage':
        closeOverlay();
        openOverlay(modal('Move to campaign', '<select class="select" id="mvCamp"><option value="">No campaign</option>' + D.campaigns.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name) + '</option>'; }).join('') + '</select>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="doMove" data-id="' + id + '">Move</button>'));
        break;
      case 'doMove': reauthAfterMutation(api('/pages/' + id, { method: 'PATCH', body: { campaignId: document.getElementById('mvCamp').value || null } }), 'Page moved').then(closeOverlay, function () {}); break;
      case 'domain':
        closeOverlay();
        openOverlay(modal('Connect custom domain', '<div class="field"><label>Domain</label><input class="input" id="domName" placeholder="offers.yourbrand.com"/></div><div id="domResult"></div>', '<button class="btn btn-ghost" data-act="close">Close</button><button class="btn btn-primary" data-act="addDomain" data-id="' + id + '">Connect Domain</button>'));
        break;
      case 'addDomain':
        api('/pages/' + id + '/domain', { method: 'POST', body: { domainName: document.getElementById('domName').value } }).then(function (r) {
          document.getElementById('domResult').innerHTML = '<div class="card" style="margin-top:16px"><b>Add this one line to your domain settings</b><div class="mono" style="margin-top:8px">' + esc(r.record.name) + ' → CNAME → ' + esc(r.record.value) + '</div><p class="small">Log into your domain registrar → Find DNS Settings → Add a CNAME record → Save → come back here. This usually takes a few minutes, sometimes up to 24 hours.</p><button class="btn btn-ghost btn-sm" data-act="verifyDomain" data-id="' + r.id + '">Verify Now</button></div>';
        }, fail);
        break;
      case 'verifyDomain':
        done = busy(el);
        api('/domains/' + id + '/verify', { method: 'POST' }).then(function (r) { done(); toast(r.message, r.verified ? '' : 'info'); if (r.verified) reload(true); }, function (x) { done(); fail(x); });
        break;
      case 'upload': S.uploadStep = 1; S.redeployId = null; S.uploadCamp = el.getAttribute('data-camp') || null; S.uploadCampLocked = !!S.uploadCamp; openOverlay(uploadModal()); break;
      case 'redeploy': S.uploadStep = 1; S.redeployId = id; openOverlay(uploadModal()); break;
      case 'uploadEntry': uploadZip(S.uploadFile, document.getElementById('upEntry').value); break;
      case 'uploadSave':
        var camSel = document.getElementById('upCamp');
        done = busy(el);
        api('/pages/' + S.uploadId, { method: 'PATCH', body: { name: document.getElementById('upName').value || undefined, campaignId: camSel.value || null, slug: document.getElementById('upSlug').value || undefined } })
          .then(function () { return loadCore(); }).then(function () { S.uploadStep = 4; openOverlay(uploadModal()); render(true); }, function (x) { done(); fail(x); });
        break;
      case 'testHook':
        done = busy(el);
        api('/pages/' + id + '/webhook/test', { method: 'POST' }).then(function (r) { done(); toast(r.ok ? 'Test sent ✓ — signature verified in ' + r.latencyMs + 'ms' : 'Webhook test failed', r.ok ? '' : 'error'); }, function (x) { done(); fail(x); });
        break;
      case 'slaTab': S.slaTab = v; render(true); break;
      case 'slaDay': S.slaDay = v === '' ? null : +v; render(true); break;
      case 'saveSla':
        var mins = Math.round(+document.getElementById('slaMin').value * +document.getElementById('slaUnit').value);
        var errEl = document.getElementById('slaErr');
        if (!(mins > 0)) { errEl.textContent = 'Please enter a value greater than 0.'; errEl.classList.remove('hidden'); break; }
        var vipIds = Array.prototype.slice.call(document.querySelectorAll('[data-vip].on')).map(function (x) { return x.getAttribute('data-vip'); });
        done = busy(el);
        api('/sla/config', { method: 'PATCH', body: { sla_threshold_minutes: mins, vip_lead_enabled: document.getElementById('vipToggle').classList.contains('on'), vip_sla_threshold_minutes: +document.getElementById('vipMin').value, daily_summary_time: document.getElementById('digestTime').value, vipPages: vipIds } })
          .then(function (r) { done(); el.classList.add('success'); el.innerHTML = 'Saved ' + ic('check', 13); if (r.warnings && r.warnings.length) toast(r.warnings[0], 'info'); setTimeout(function () { el.classList.remove('success'); el.innerHTML = 'Save Changes'; }, 2000); inval('sla:'); reload(true); }, function (x) { done(); fail(x); });
        break;
      case 'saveRules':
        var rules = Array.prototype.slice.call(document.querySelectorAll('[data-member]')).map(function (r) { return { id: r.getAttribute('data-member'), notifyChannel: r.querySelector('select').value, notifyEnabled: r.querySelector('.toggle').classList.contains('on') }; });
        api('/sla/config', { method: 'PATCH', body: { notificationRules: rules } }).then(function () { toast('Notification rules saved'); inval('sla:config'); }, fail);
        break;
      case 'saveCross':
        var cardEl = el.closest('[data-integration]');
        var chans = Array.prototype.slice.call(cardEl.querySelectorAll('[data-ch]:checked')).map(function (x) { return x.getAttribute('data-ch'); });
        var rr = Array.prototype.slice.call(cardEl.querySelectorAll('[data-rule]')).map(function (r) { return { id: r.getAttribute('data-rule'), thresholdValue: +r.querySelector('input').value, enabled: r.querySelector('.toggle').classList.contains('on'), notificationChannels: chans }; });
        api('/sla/config/cross-tool', { method: 'PATCH', body: { integrationId: id, rules: rr } }).then(function () { el.classList.add('success'); el.innerHTML = 'Saved ' + ic('check', 13); setTimeout(function () { el.classList.remove('success'); el.innerHTML = 'Save Changes'; }, 1500); }, fail);
        break;
      case 'notify':
        done = busy(el);
        api('/sla/notify/' + id, { method: 'POST' }).then(function (r) { el.classList.remove('loading'); el.classList.add('success'); el.innerHTML = ic('check', 13) + ' Notified'; toast('Sent via ' + r.channels.join(' + ')); setTimeout(function () { done(); el.classList.remove('success'); }, 3000); },
          function (x) { done(); el.innerHTML = ic('warn', 13) + ' Notify Now'; el.setAttribute('title', 'Last notification failed. Try again.'); fail(x); });
        break;
      case 'toggle': el.classList.toggle('on'); if (el.id === 'fbToggle') api('/settings/ai-provider', { method: 'PATCH', body: { fallback: { enabled: el.classList.contains('on') } } }).then(function () { delete C['set:ai']; render(true); }, fail); break;
      case 'ruleToggle':
        el.classList.toggle('on'); var row = el.parentNode; row.classList.toggle('off');
        row.querySelectorAll('input,select').forEach(function (x) { x.disabled = !el.classList.contains('on'); }); break;
      case 'eye': var f = document.getElementById(el.getAttribute('data-for')); f.type = f.type === 'password' ? 'text' : 'password'; break;
      case 'copy': (navigator.clipboard ? navigator.clipboard.writeText(v || '') : Promise.reject()).then(function () { toast('Copied to clipboard'); }, function () { toast('Copy failed — select and copy manually', 'error'); }); break;
      case 'saveWs': reauthAfterMutation(api('/workspace', { method: 'PATCH', body: { name: document.getElementById('wsName').value } }), 'Workspace saved'); break;
      case 'removeLogo': reauthAfterMutation(api('/workspace/logo', { method: 'DELETE' }), 'Logo removed'); break;
      case 'saveAi':
        var body2 = { refreshIntervalMinutes: +document.getElementById('aiEvery').value, eventTriggers: Array.prototype.slice.call(document.querySelectorAll('#aiTriggers input:checked')).map(function (x) { return x.value; }) };
        document.querySelectorAll('[data-provider]').forEach(function (blk) {
          var w = blk.getAttribute('data-provider'), o = {};
          o.provider = blk.querySelector('[data-f=provider]').value || null;
          o.modelName = blk.querySelector('[data-f=modelName]').value || null;
          var k = blk.querySelector('[data-f=apiKey]').value; if (k) o.apiKey = k;
          body2[w] = o;
        });
        done = busy(el);
        api('/settings/ai-provider', { method: 'PATCH', body: body2 }).then(function (r) { done(); C['set:ai'] = r; toast('AI provider saved'); render(true); }, function (x) { done(); fail(x); });
        break;
      case 'verifyAi':
        var blk = el.closest('[data-provider]'), pbody = {};
        pbody[v] = { provider: blk.querySelector('[data-f=provider]').value || null, modelName: blk.querySelector('[data-f=modelName]').value || null };
        var key2 = blk.querySelector('[data-f=apiKey]').value; if (key2) pbody[v].apiKey = key2;
        done = busy(el);
        api('/settings/ai-provider', { method: 'PATCH', body: pbody }).then(function () { return api('/integrations/ai/verify', { method: 'POST', body: { which: v } }); })
          .then(function (r) { done(); toast(r.ok ? 'Key verified' : 'Verification failed — check the key and model name', r.ok ? '' : 'error'); delete C['set:ai']; render(true); }, function (x) { done(); fail(x); });
        break;
      case 'verifyTg':
        done = busy(el);
        api('/settings/telegram/verify', { method: 'POST', body: { botToken: document.getElementById('tgToken').value } }).then(function (r) { done(); toast(r.ok ? 'Connected to @' + r.botUsername : 'Could not verify that bot token', r.ok ? '' : 'error'); delete C['set:tg']; render(true); }, function (x) { done(); fail(x); });
        break;
      case 'tgToggle':
        el.classList.toggle('on'); var tb = {}; tb[v] = el.classList.contains('on');
        api('/settings/telegram', { method: 'PATCH', body: tb }).then(function (r) { C['set:tg'] = r; }, fail); break;
      case 'disconnectTg': api('/settings/telegram', { method: 'DELETE' }).then(function () { delete C['set:tg']; toast('Telegram disconnected'); render(true); }, fail); break;
      case 'connectInt':
        var meta = (C['set:int'] || []).filter ? (C['set:int'] || []).filter(function (x) { return x.provider === v; })[0] : null;
        var needsKey = !meta || meta.methods.indexOf('api_key') >= 0;
        openOverlay(modal('Connect ' + esc(meta ? meta.name : v), (needsKey ? '<div class="field"><label>API key' + (meta && meta.methods.indexOf('webhook') >= 0 ? ' (optional for webhook-only)' : '') + '</label><input class="input mono" type="password" id="intKey" placeholder="Paste API key"/></div>' : '') +
          '<p class="small">' + (meta && meta.methods.indexOf('webhook') >= 0 ? 'Camplo will generate a webhook URL for this tool’s events.' : 'The key lets Camplo query this tool on its intelligence schedule.') + ' Keys are encrypted at rest.</p>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="doConnect" data-v="' + v + '">Connect</button>'));
        break;
      case 'doConnect':
        var kEl = document.getElementById('intKey');
        done = busy(el);
        api('/integrations/' + v + '/connect', { method: 'POST', body: kEl && kEl.value ? { apiKey: kEl.value } : { method: 'webhook' } }).then(function () { done(); closeOverlay(); toast('Connected'); delete C['set:int']; delete C['sla:crossConfig']; render(true); },
          function (x) { done(); if (x.data && x.data.reason === 'plan_required') openOverlay(upgradeModal(x.data.plan)); else fail(x); });
        break;
      case 'verifyInt': api('/integrations/' + v + '/verify', { method: 'POST' }).then(function (r) { toast(r.ok ? 'Verified' : 'Verification failed', r.ok ? '' : 'error'); delete C['set:int']; render(true); }, fail); break;
      case 'disconnectInt': if (confirm('Disconnect this integration?')) api('/integrations/' + v, { method: 'DELETE' }).then(function () { toast('Disconnected'); delete C['set:int']; render(true); }, fail); break;
      case 'createInbound':
        var lbl = document.getElementById('ibLabel').value.trim();
        if (!lbl) { document.getElementById('ibLabel').classList.add('err'); break; }
        api('/webhooks/inbound', { method: 'POST', body: { sourceLabel: lbl, campaignId: document.getElementById('ibCamp').value || null } }).then(function (r) {
          delete C['set:inbound']; render(true);
          openOverlay(modal('Inbound webhook created', '<div class="label">URL</div><div class="mono" style="word-break:break-all">' + esc(r.url) + '</div><div class="label" style="margin-top:12px">Signing secret — shown once</div><div class="mono" style="word-break:break-all">' + esc(r.secret) + '</div><p class="small">Sign each request body with HMAC-SHA256 using this secret and send it as <span class="mono">X-Camplo-Signature: sha256=&lt;hex&gt;</span>.</p>', '<button class="btn btn-primary" data-act="close">Done</button>'));
        }, fail);
        break;
      case 'deleteInbound': if (confirm('Delete this endpoint? Tools sending to it will stop working.')) api('/webhooks/inbound/' + id, { method: 'DELETE' }).then(function () { delete C['set:inbound']; render(true); }, fail); break;
      case 'createOutbound':
        api('/webhooks/outbound', { method: 'POST', body: { destinationUrl: document.getElementById('obUrl').value, eventTrigger: document.getElementById('obEvent').value, secret: document.getElementById('obSecret').value || null } }).then(function () { toast('Outbound webhook added'); delete C['set:outbound']; render(true); }, fail);
        break;
      case 'deleteOutbound': api('/webhooks/outbound/' + id, { method: 'DELETE' }).then(function () { delete C['set:outbound']; render(true); }, fail); break;
      case 'saveNotif':
        var nb = { dailyDigestTime: document.getElementById('nDigest').value, slaBreachChannel: document.getElementById('nChannel').value };
        document.querySelectorAll('[data-n]').forEach(function (t) { nb[t.getAttribute('data-n')] = t.classList.contains('on'); });
        api('/settings/notifications', { method: 'PATCH', body: nb }).then(function (r) { C['set:notif'] = r; toast('Notification settings saved'); }, fail);
        break;
      case 'notifs':
        api('/notifications').then(function (n) {
          D.notifs = n;
          var icons = { sla_breach: ['clock', 'red'], webhook_offline: ['link', 'amber'], insight: ['brain', 'blue'], team_note: ['note', 'blue'], assignment: ['inbox', 'blue'] };
          popover('<div class="spread" style="padding:8px 12px"><b>Notifications</b><button class="linkbtn" data-act="readAll">Mark all read</button></div>' +
            (n.notifications.length ? n.notifications.map(function (x) { var i = icons[x.kind] || ['bell', 'blue']; return '<div class="notif" data-act="openNotif" data-id="' + x.id + '" data-v="' + esc(x.link || '') + '" style="' + (x.read ? '' : 'background:var(--bg-hover)') + '"><span class="' + i[1] + '" style="margin-top:2px">' + ic(i[0], 15) + '</span><div class="grow"><div style="font-size:13px">' + esc(x.description) + '</div><div class="ts">' + ago(ms(x.createdAt)) + '</div></div>' + (x.read ? '' : '<span class="dot b dot6" style="margin-top:6px"></span>') + '</div>'; }).join('') : '<div class="empty" style="padding:24px"><p class="muted">You\'re all caught up.</p></div>'), el, 360);
        }, fail);
        break;
      case 'readAll': api('/notifications/all/read', { method: 'POST' }).then(function () { closeOverlay(); reload(true); }, fail); break;
      case 'openNotif': closeOverlay(); api('/notifications/' + id + '/read', { method: 'POST' }).then(function () { reload(); }); if (v) go(v.replace(/^\//, '')); break;
      case 'usermenu':
        popover('<div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle);margin-bottom:4px"><b>' + esc(D.me.name) + '</b><div class="ts">' + esc(D.me.email) + '</div></div>' +
          '<div class="menu-item" data-go="me">My Performance</div><div class="menu-item" data-go="settings">Settings</div><div class="menu-item" ' + (D.plan !== 'watchtower' ? 'data-act="upgrade" data-plan="' + (D.plan === 'starter' ? 'growth' : 'watchtower') + '"' : '') + '>Current plan: ' + cap(D.plan) + (D.plan !== 'watchtower' ? ' <span class="chip chip-plan" style="margin-left:auto">Upgrade</span>' : '') + '</div><div class="menu-item" data-act="shortcuts">Keyboard shortcuts</div>' +
          '<div style="height:1px;background:var(--border-subtle);margin:4px 0"></div><div class="menu-item" style="color:var(--status-red)" data-act="logout">Sign out</div>', el, 240);
        break;
      case 'logout': api('/auth/logout', { method: 'POST' }).finally(function () { D = null; C = {}; streams.forEach(function (s) { s.close(); }); closeOverlay(); go('login'); }); break;
      case 'shortcuts': openOverlay(modal('Keyboard shortcuts', '<dl class="kv" style="grid-template-columns:1fr auto"><dt>Search</dt><dd class="mono">⌘ K</dd><dt>Post note / send message</dt><dd class="mono">⌘ Enter</dd><dt>Close panel</dt><dd class="mono">Esc</dd></dl>')); break;
      case 'upgrade': openOverlay(upgradeModal(el.getAttribute('data-plan'))); break;
      case 'doUpgrade':
        done = busy(el);
        api('/workspace/upgrade', { method: 'POST', body: { targetPlan: el.getAttribute('data-plan') } }).then(function (r) {
          if (r.checkoutUrl) { location.href = r.checkoutUrl; return; }
          closeOverlay(); toast('Plan upgraded'); C = {}; reload(true);
        }, function (x) { done(); var er = document.getElementById('upgErr'); er.textContent = x.message; er.classList.remove('hidden'); });
        break;
      case 'share':
        api('/campaigns/' + id + '/share-link').then(function (r) { return r; }, function (x) { if (x.status === 404) return null; throw x; }).then(function (r) {
          openOverlay(modal('Share with client', '<p class="small">Clients see leads, response counts, speed-to-lead, health and high-level observations. No team names, notes, settings or other campaigns.</p>' +
            (r ? '<div class="input-wrap" style="margin-top:12px"><input class="input mono" readonly value="' + esc(r.shareUrl) + '" style="font-size:12px" /><span class="acts"><button data-act="copy" data-v="' + esc(r.shareUrl) + '">' + ic('copy', 14) + '</button></span></div>' : ''),
            r ? '<button class="btn btn-ghost" data-act="revokeShare" data-id="' + id + '">Revoke link</button><a class="btn btn-primary" target="_blank" rel="noopener" href="' + esc(r.shareUrl) + '">View as client</a>' : '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="genShare" data-id="' + id + '">Generate link</button>'));
        }, fail);
        break;
      case 'genShare': api('/campaigns/' + id + '/share-link', { method: 'POST' }).then(function () { closeOverlay(); document.querySelector('[data-act="share"][data-id="' + id + '"]').click(); }, fail); break;
      case 'revokeShare': api('/campaigns/' + id + '/share-link', { method: 'DELETE' }).then(function () { closeOverlay(); toast('Link revoked'); }, fail); break;
      case 'shareRefresh': delete C['share:' + v]; render(true); break;
      case 'ackNow':
        done = busy(el);
        api('/leads/acknowledge', { method: 'POST', body: { token: v } }).then(function (r) { C['ack:' + v] = r; render(true); }, function (x) { done(); fail(x); });
        break;
      case 'invite':
        openOverlay(modal('Invite team member', '<div class="col gap16"><div class="field"><label>Email</label><input class="input" id="invEmail" type="email" placeholder="teammate@company.com" /><span class="errmsg hidden" id="invErr"></span></div><div class="field"><label>Role</label><select class="select" id="invRole"><option value="member">Member</option><option value="admin">Admin</option></select></div><div class="ts">They get an email with a link to accept. Invitations expire after 7 days.</div></div>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="sendInvite">Send Invite</button>'));
        break;
      case 'sendInvite':
        var em = document.getElementById('invEmail'), ie = document.getElementById('invErr');
        if (!/^\S+@\S+\.\S+$/.test(em.value)) { em.classList.add('err'); ie.textContent = 'Enter a valid email address.'; ie.classList.remove('hidden'); break; }
        done = busy(el);
        api('/team/invitations', { method: 'POST', body: { email: em.value, role: document.getElementById('invRole').value } }).then(function () {
          delete C['set:invites'];
          openOverlay(modal('Invitation sent', '<div class="empty" style="padding:16px"><div class="check-big">' + ic('check', 28) + '</div><p>Invitation sent to <b>' + esc(em.value) + '</b></p></div>', '<button class="btn btn-ghost" data-act="invite">Invite another</button><button class="btn btn-primary" data-act="close">Done</button>'));
        }, function (x) { done(); if (x.data && x.data.reason === 'plan_limit') openOverlay(upgradeModal('growth')); else { ie.textContent = x.message; ie.classList.remove('hidden'); } });
        break;
      case 'resendInvite': api('/team/invitations/' + id + '/resend', { method: 'POST' }).then(function (r) { toast('Invitation resent to ' + r.email); delete C['set:invites']; render(true); }, fail); break;
      case 'cancelInvite': api('/team/invitations/' + id, { method: 'DELETE' }).then(function () { delete C['set:invites']; render(true); }, fail); break;
      case 'member': if (e.target.closest('.acts')) break; openLive(function () { return memberDrawer(id); }); break;
      case 'editRole':
        e.stopPropagation();
        popover(['admin', 'member'].map(function (r) { return '<div class="menu-item" data-act="setRole" data-id="' + id + '" data-v="' + r + '">' + cap(r) + '</div>'; }).join(''), el, 160); break;
      case 'setRole':
        closeOverlay(); var mm = byId(D.team, id); if (mm) mm.role = v.toUpperCase(); render(true);
        api('/team/members/' + id + '/role', { method: 'PATCH', body: { role: v } }).then(function () { toast('Role updated'); delete C['member:' + id]; reload(true); }, function (x) { fail(x); reload(true); });
        break;
      case 'removeMember':
        e.stopPropagation();
        openOverlay(modal('Remove ' + esc(user(id).name) + '?', '<p class="small" style="font-size:14px">Remove ' + esc(user(id).name) + ' from your workspace? This cannot be undone. Their activity will be preserved in all audit trails.</p>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-danger" data-act="confirmRemove" data-id="' + id + '">Remove</button>'));
        break;
      case 'confirmRemove': reauthAfterMutation(api('/team/members/' + id, { method: 'DELETE' }), 'Member removed.').then(closeOverlay, function () {}); break;
      case 'postTeamNote':
        var tb2 = document.getElementById('tnBody'), te = document.getElementById('tnErr');
        var to = Array.prototype.slice.call(document.querySelectorAll('#tnTo input:checked')).map(function (x) { return x.value; });
        if (!tb2.value.trim() || !to.length) { te.textContent = !to.length ? 'Tag at least one team member.' : 'Write a note.'; te.classList.remove('hidden'); break; }
        var att = document.getElementById('tnAttach').value.split(':'), due = document.getElementById('tnDue').value;
        done = busy(el);
        api('/team-notes', { method: 'POST', body: { content: tb2.value.trim(), recipientIds: to, attachmentType: att[1] ? att[0] : null, attachmentId: att[1] || null, deadline: due ? new Date(due).toISOString() : null } })
          .then(function () { toast('Team note posted — they have been notified'); reload(true); }, function (x) { done(); fail(x); });
        break;
      case 'ackTeamNote':
        var tn = byId(D.teamNotes, id); if (tn) { tn.deadlineStatus = 'met'; tn.canAcknowledge = false; tn.unread = false; } render(true);
        api('/team-notes/' + id + '/acknowledge', { method: 'POST' }).then(function () { reload(); }, function (x) { fail(x); reload(true); });
        break;
      case 'logRange': S.logRange = { from: document.getElementById('logFrom').value, to: document.getElementById('logTo').value }; render(true); break;
      case 'logClear': S.logRange = {}; render(true); break;
      case 'ob1':
        done = busy(el);
        api('/workspace', { method: 'PATCH', body: { name: document.getElementById('obName').value, teamSize: document.getElementById('obSize').value, hasMarketingStack: document.getElementById('obStack').checked, stackCheckCompleted: true } }).then(function () { return loadCore(); }).then(function () { go('onboarding/2'); }, function (x) { done(); fail(x); });
        break;
      case 'finishSetup': api('/workspace', { method: 'PATCH', body: { setupComplete: true } }).then(function () { return loadCore(); }).then(function () { connectRT(); go('dashboard'); }, fail); break;
    }
  });

  function findRec(id) {
    var all = D.recs.slice();
    Object.keys(C).forEach(function (k) { if (k.indexOf('camp:recs:') === 0 && Array.isArray(C[k])) all = all.concat(C[k]); });
    return all.filter(function (r) { return r.recommendation_id === id; })[0];
  }

  render();
})();
