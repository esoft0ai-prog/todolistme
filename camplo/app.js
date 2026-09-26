/* Camplo — clickable product build. Vanilla JS, hash routing, no build step. */
(function () {
  'use strict';
  var D = window.CAMPLO;
  var MIN = D.MIN, HOUR = D.HOUR, DAY = D.DAY;
  var app = document.getElementById('app');
  var overlay = document.getElementById('overlay');

  // ---------- state ----------
  var S = {
    briefDismissed: store('camplo-brief') === new Date().toDateString(),
    insightFilter: 'All',
    leadFilter: { status: 'all', campaign: 'all', assignee: 'all', sort: 'newest' },
    slaTab: 'live', slaDay: null,
    chat: [
      { sep: 'Yesterday' },
      { u: 'Why did Black Friday CPL jump this week?' },
      { a: 'CPL rose from <span class="metric">₦11,610</span> to <span class="metric red">₦14,860</span> (+28%). Ad CTR is flat, so traffic quality is not the cause. The drop is at the page: <a href="#/pages" data-link>bf-bundle-b</a> conversion fell from 9.1% to 4.2% on Sep 22 — the same day its webhook began dropping submissions.' },
      { sep: 'Today' }
    ],
    chatOpen: false, depthOpen: false, depth: 'Standard', loaded: {},
    editNote: null, editingOverview: false
  };

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
  }

  // ---------- utils ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function byId(list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function user(id) { return byId(D.team, id) || { name: 'Unknown', initials: '?' }; }
  function camp(id) { return byId(D.campaigns, id); }
  function naira(n) { return '₦' + Math.round(n).toLocaleString('en-US'); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dur(ms, withSec) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + pad(m) + 'm' + (withSec ? ' ' + pad(sec) + 's' : '');
    if (m || !withSec) return m + 'm ' + pad(sec) + 's';
    return sec + 's';
  }
  function secs(n) { return dur(n * 1000, true); }
  function ago(ts) {
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
  function fmtDate(ts) { return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function speedClass(sec) { return sec < 300 ? 'green' : sec <= 1800 ? 'amber' : 'red'; }
  function healthBadge(h) { return '<span class="badge ' + ({ HEALTHY: 'b-green', WATCH: 'b-amber', CRITICAL: 'b-red' }[h]) + '">' + h + '</span>'; }
  function av(id, size) { var u = user(id); return '<span class="avatar ' + (size ? 's' + size : '') + '" title="' + esc(u.name) + '">' + esc(u.initials) + '</span>'; }
  function first(id) { return user(id).name.split(' ')[0]; }

  // ---------- icons ----------
  var P = {
    brain: '<path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-1.54Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-1.54Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    gear: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    chev: '<path d="m9 18 6-6-6-6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    send: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    file: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>',
    note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z"/><path d="M15 3v6h6"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    feed: '<path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
    warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>'
  };
  function ic(name, size, extra) { size = size || 16; return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' + (extra || '') + '>' + P[name] + '</svg>'; }
  // Lifecycle icon (§7.2): three dots on a vertical line — never a snowflake.
  function lifeIcon() { return '<svg class="lifecycle-ico" width="16" height="20" viewBox="0 0 16 20" fill="currentColor" aria-hidden="true"><rect x="7.5" y="3" width="1" height="14"/><circle cx="8" cy="3" r="3"/><circle cx="8" cy="9.5" r="3"/><circle cx="8" cy="16" r="4"/></svg>'; }

  // ---------- derived data ----------
  function waiting(l) { return (l.respondedAt || Date.now()) - l.arrived; }
  function isOverdue(l) { return !l.respondedAt && Date.now() - l.arrived > D.slaMinutes * MIN; }
  function responded() { return D.leads.filter(function (l) { return l.respondedAt; }); }
  function avgResponse(list) {
    list = (list || responded()).filter(function (l) { return l.respondedAt; });
    if (!list.length) return 0;
    return Math.round(list.reduce(function (a, l) { return a + (l.respondedAt - (l.assignedAt || l.arrived)); }, 0) / list.length / 1000);
  }
  function overdueLeads() { return D.leads.filter(isOverdue).sort(function (a, b) { return a.arrived - b.arrived; }); }
  function canRespond(l) { return !l.respondedAt && (!l.assignee || l.assignee === D.me); }

  // ---------- routing ----------
  function route() {
    var h = location.hash.replace(/^#\/?/, '') || 'dashboard';
    return h.split('?')[0].split('/');
  }
  function go(path) { location.hash = '#/' + path; }

  var AUTH = { login: 1, signup: 1, forgot: 1, reset: 1, onboarding: 1, client: 1 };

  function render() {
    var r = route(), top = r[0];
    closeOverlay(true);
    document.body.classList.toggle('has-mnav', !AUTH[top]);
    var html;
    if (top === 'login') html = authLogin();
    else if (top === 'signup') html = authSignup();
    else if (top === 'forgot') html = authForgot();
    else if (top === 'reset') html = authReset();
    else if (top === 'onboarding') html = onboarding(+r[1] || 1);
    else if (top === 'client') html = clientView(r[1] || 'bf26');
    else html = shell(r);
    app.innerHTML = html;
    window.scrollTo(0, 0);
    tick(); tickSlow();
    if (top === 'dashboard' || top === '') runIntelLoad();
  }
  window.addEventListener('hashchange', render);

  // ---------- shell ----------
  function shell(r) {
    var top = r[0], body;
    if (top === 'dashboard') body = dashboard();
    else if (top === 'leads') body = leadInbox();
    else if (top === 'campaigns' && r[2] === 'leads' && r[3]) body = dossier(r[1], r[3]);
    else if (top === 'campaigns') body = campaignDetail(r[1] || 'bf26', r[2] || 'overview');
    else if (top === 'pages') body = pagesScreen();
    else if (top === 'sla') body = slaScreen();
    else if (top === 'team-notes') body = teamNotesScreen();
    else if (top === 'me') body = myPerformance();
    else if (top === 'settings') body = settingsScreen(r[1] || 'team');
    else if (top === 'feed') body = mobileFeed();
    else body = '<div class="page">' + empty('target', 'Nothing here.', 'That screen does not exist.', '<a class="btn btn-ghost" href="#/dashboard">Back to dashboard</a>') + '</div>';
    return topnav(top) + strip() + '<main>' + body + '</main>' + dock() +
      '<button class="brain-fab" data-act="chat">' + ic('brain', 18) + '<span>Ask Camplo</span></button>' +
      '<nav class="mnav"><button class="' + (top === 'feed' || top === 'dashboard' ? 'active' : '') + '" data-go="feed">' + ic('feed', 20) + 'Feed</button><button data-act="chat">' + ic('chat', 20) + 'Chat</button></nav>';
  }

  function topnav(top) {
    var tabs = [['dashboard', 'Campaign'], ['leads', 'Leads'], ['pages', 'Pages'], ['sla', 'SLA'], ['team-notes', 'Team Notes']];
    var active = top === 'campaigns' ? 'dashboard' : top;
    var sp = avgResponse(), unread = 3;
    return '<header class="topnav">' +
      '<div class="logo" data-go="dashboard" aria-label="Camplo home">C<span>.</span></div>' +
      '<nav class="tabs">' + tabs.map(function (t) { return '<a class="tab ' + (active === t[0] ? 'active' : '') + '" href="#/' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' +
      '<div class="search" id="search"><span class="ico">' + ic('search', 15) + '</span><input id="searchInput" placeholder="Search campaigns, leads, pages" autocomplete="off" /><kbd>⌘K</kbd></div>' +
      '<div class="nav-right">' +
      '<div class="mobile-only row"><span class="badge b-red b-bold">' + overdueLeads().length + ' overdue</span></div>' +
      '<div class="stl" data-go="sla" title="Workspace Speed-to-Lead"><span class="label">Avg response</span><b class="' + speedClass(sp) + '">' + secs(sp) + '</b></div>' +
      '<button class="iconbtn" data-act="notifs" aria-label="Notifications">' + ic('bell', 18) + '<span class="dot-badge">' + unread + '</span></button>' +
      '<span class="avatar me" data-act="usermenu">' + user(D.me).initials + '</span>' +
      '</div></header>';
  }

  // Live command strip: rule-based (Level 0) signals, zero LLM, always current.
  function strip() {
    var od = overdueLeads().length;
    var unclaimed = D.leads.filter(function (l) { return !l.respondedAt && !l.assignee; }).length;
    var offline = D.pages.filter(function (p) { return p.hook === 'offline'; }).length;
    var today = D.leads.filter(function (l) { return Date.now() - l.arrived < DAY; }).length;
    return '<div class="strip">' +
      '<div class="strip-item strip-live"><span class="dot g pulse-slow"></span> Watching 5 campaigns · 8 pages · 4 tools</div>' +
      '<div class="strip-item" data-go="sla"><span class="dot r ' + (od ? 'pulse-fast' : '') + '"></span><b>' + od + '</b> overdue</div>' +
      '<div class="strip-item" data-go="leads"><span class="dot o pulse-orange"></span><b>' + unclaimed + '</b> unclaimed</div>' +
      '<div class="strip-item" data-go="pages"><span class="dot r"></span><b>' + offline + '</b> webhook offline</div>' +
      '<div class="strip-item" data-go="leads"><b>' + today + '</b> leads today</div>' +
      '<div class="strip-item" data-go="campaigns/bf26/overview">Black Friday CPL <b class="amber">₦14,860</b></div>' +
      '<div class="strip-item strip-live">AI refreshed <span data-ago="' + (Date.now() - 12 * MIN) + '"></span> · next in 18m</div>' +
      '</div>';
  }

  function dock() {
    var light = document.documentElement.getAttribute('data-theme') === 'light';
    return '<div class="dock">' +
      '<button class="iconbtn tip" data-tip="Webhooks & API" data-go="settings/webhooks">' + ic('link', 17) + '</button>' +
      '<button class="iconbtn tip" data-tip="' + (light ? 'Dark mode' : 'Light mode') + '" data-act="theme">' + ic(light ? 'moon' : 'sun', 17) + '</button>' +
      '<button class="iconbtn tip" data-tip="Settings" data-go="settings/team">' + ic('gear', 17) + '</button></div>';
  }

  function empty(icon, h, p, action) {
    return '<div class="empty">' + ic(icon, 48, 'stroke-width="1.4"') + '<div class="h">' + h + '</div>' + (p ? '<p>' + p + '</p>' : '') + (action || '') + '</div>';
  }

  // ---------- Insight cards ----------
  var ORDER = { red: 1, amber: 2, blue: 3, green: 4 };
  function sortInsights(list) { return list.slice().sort(function (a, b) { return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || ORDER[a.type] - ORDER[b.type] || b.t - a.t; }); }
  function insightCard(i, idx) {
    var c = camp(i.camp);
    return '<article class="insight t-' + i.type + (i.priority ? ' priority' : '') + (Date.now() - i.t < HOUR && !i.priority ? ' unread' : '') + '" style="animation-delay:' + (idx * 70) + 'ms">' +
      (i.priority ? '<div class="pf-label">' + ic('flag', 12) + ' Priority flag · 3 SLA flags on one campaign</div>' : '') +
      '<div class="obs">' + esc(i.obs) + '</div>' +
      '<div class="ev">' + esc(i.ev) + '</div>' +
      '<div class="meta">' + (c ? '<a class="chip chip-blue" href="#/campaigns/' + c.id + '/insights">' + esc(c.name) + '</a>' : '') + '<span class="ts" data-ago="' + i.t + '"></span></div>' +
      '<button class="expand" data-act="insight" data-id="' + i.id + '" aria-label="Expand insight">' + ic('expand', 14) + '</button></article>';
  }

  // ---------- Screen 1: Dashboard ----------
  function dashboard() {
    var me = user(D.me);
    var od = overdueLeads(), worst = od[0];
    var h = new Date().getHours(), greet = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    var sp = avgResponse();
    var brief = S.briefDismissed ? '' :
      '<section class="glass brief">' +
      '<button class="close brief-close" data-act="dismissBrief" aria-label="Dismiss brief">' + ic('x', 16) + '</button>' +
      '<div class="row gap12"><div class="brain-ico">' + ic('brain', 18) + '</div><div><div class="h1" style="font-size:24px">' + greet + ', ' + esc(me.name.split(' ')[0]) + '</div>' +
      '<div class="small">' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + ' · Camplo has been watching since you left — here is what changed.</div></div></div>' +
      '<div class="brief-grid">' +
      '<div><div class="label">What happened yesterday</div><div class="brief-stat"><b>47</b><span class="small">leads received</span></div><div class="small" style="margin-top:6px"><span class="green">44 responded</span> · <span class="red">3 SLA breaches</span> · 1 campaign flagged</div></div>' +
      '<div><div class="label">Needs attention today</div><div class="brief-stat"><b class="red">' + od.length + '</b><span class="small">overdue leads</span></div>' +
      (worst ? '<div class="small" style="margin-top:6px">Most urgent: <a href="#/campaigns/' + worst.campaign + '/leads/' + worst.id + '">' + esc(worst.name) + '</a> · <span class="red" data-since="' + worst.arrived + '"></span></div>' : '') + '</div>' +
      '<div><div class="label">AI noticed overnight</div><ul style="margin:8px 0 0;padding-left:16px;font-size:13px;color:var(--text-secondary);line-height:1.6">' +
      '<li>bf-bundle-b webhook went silent at 01:40 while ads kept spending</li><li>Lekki email step 2 open rate collapsed to 14%</li><li>Webinar page converting at 2.1× account average</li></ul></div>' +
      '<div><div class="label">Your speed-to-lead (yesterday)</div><div class="brief-stat"><b class="' + speedClass(252) + '">4m 12s</b></div><div class="small" style="margin-top:6px"><span class="green">' + ic('arrowDown', 12) + ' 1m 28s</span> faster than your 30-day avg</div></div>' +
      '</div></section>';

    var ins = sortInsights(D.insights);
    var rules = '<div class="rule-strip red" data-go="sla">' + ic('clock', 15) + '<b>' + od.length + ' leads overdue</b> against your ' + D.slaMinutes + 'm threshold<span class="tag">Rule · live</span></div>' +
      '<div class="rule-strip red" data-go="pages">' + ic('link', 15) + '<b>bf-bundle-b</b> webhook offline · last ping <span data-ago="' + D.pages[1].ping + '"></span><span class="tag">Rule · live</span></div>' +
      '<div class="rule-strip amber" data-go="pages">' + ic('warn', 15) + '<b>72h watch:</b> bf-vip-early has 4 leads in 31h<span class="tag">Rule · live</span></div>';

    var intel = '<section class="glass intel">' +
      '<div class="spread"><div class="intel-head"><div class="brain-ico think">' + ic('brain', 18) + '</div><div><div class="h3">Camplo Intelligence</div><div class="watching" style="margin-top:2px">Watching your workplace</div></div></div>' +
      '<div class="row"><span class="ts">6 sources · refreshed <span data-ago="' + (Date.now() - 12 * MIN) + '"></span></span><button class="btn btn-ghost btn-sm" data-act="chat">' + ic('chat', 14) + ' Ask</button></div></div>' +
      '<div class="load-dots" id="intelDots"><i></i><i></i><i></i><i></i><i></i></div>' +
      '<div class="feed" id="intelFeed">' + rules + ins.map(insightCard).join('') + '</div>' +
      '<div class="section-label"><span class="label">Recommendations</span></div>' +
      '<div class="feed" style="margin-top:0">' + recCard(D.recs[0], 0) + '</div>' +
      '</section>';

    var pinned = D.campaigns.filter(function (c) { return c.pinned; });
    var recent = D.campaigns.filter(function (c) { return !c.pinned; });
    var list = '<section>' +
      '<div class="spread" style="margin-bottom:12px"><div class="h2">Campaigns</div><div class="row"><span class="ts">Pinned | ' + pinned.length + ' of 3</span><button class="btn btn-ghost btn-sm" data-act="newCampaign">' + ic('plus', 14) + ' New Campaign</button></div></div>' +
      '<div class="col gap12">' + pinned.map(campaignCard).join('') + '</div>' +
      '<div class="section-label"><span class="label">Recent campaigns</span></div>' +
      '<div class="col gap12">' + recent.map(campaignCard).join('') + '</div>' +
      '<div class="card" style="margin-top:16px;padding:16px"><div class="spread"><div class="row"><div class="stack">' + D.team.map(function (u) { return av(u.id, 28); }).join('') + '</div><span class="small">' + D.team.length + ' on the team</span></div><button class="btn btn-ghost btn-sm" data-act="invite">+ Invite</button></div></div>' +
      '</section>';

    return '<div class="page">' + brief + '<div class="cc">' + intel + list + '</div></div>';
  }

  function runIntelLoad() {
    var dots = document.getElementById('intelDots');
    if (!dots) return;
    if (S.loaded.intel) { dots.remove(); return; }
    var feed = document.getElementById('intelFeed');
    feed.style.visibility = 'hidden';
    setTimeout(function () { S.loaded.intel = true; if (dots.parentNode) dots.remove(); feed.style.visibility = ''; }, 1100);
  }

  function campaignCard(c) {
    var cls = c.status === 'COMPLETE' ? 'done' : c.health === 'CRITICAL' ? 'crit' : '';
    var cpl = c.budget ? Math.round((c.daily || 0) * Math.max(1, daysSince(c.start)) / Math.max(1, c.leads)) : null;
    return '<article class="ccard ' + cls + '" data-go="campaigns/' + c.id + '/overview">' +
      '<div class="spread"><div class="h3">' + esc(c.name) + '</div>' + (c.status === 'COMPLETE' ? '<span class="badge b-blue">Complete</span>' : healthBadge(c.health)) + '</div>' +
      '<div class="desc">' + esc(c.desc) + '</div>' +
      '<div class="row wrap gap12"><span class="small">Avg response: <b class="' + speedClass(c.avgResp) + '">' + secs(c.avgResp) + '</b></span>' + (cpl ? '<span class="ts">CPL: ' + naira(c.id === 'bf26' ? 14860 : cpl) + '</span>' : '') + '<span class="ts">' + c.leads + ' leads</span></div>' +
      '<div class="foot"><div class="stack">' + c.members.slice(0, 3).map(function (m) { return av(m, 24); }).join('') + (c.members.length > 3 ? '<span class="avatar s24">+' + (c.members.length - 3) + '</span>' : '') + '</div>' +
      '<span class="ico-inline">' + ic('file', 13) + c.pages + ' pages</span><span class="ico-inline">' + ic('note', 13) + c.notes + ' notes</span><span style="margin-left:auto">' + fmtDate(new Date(c.start).getTime()) + '</span></div>' +
      (c.status === 'COMPLETE' ? '<div class="retro-chip">' + ic('file', 14) + ' Retrospective ready <span style="margin-left:auto">' + ic('download', 14) + '</span></div>' : '') +
      '</article>';
  }
  function daysSince(d) { return Math.floor((Date.now() - new Date(d).getTime()) / DAY); }

  // ---------- Recommendation card (§13.7) ----------
  function recCard(r, idx) {
    var lvlName = { 2: 'Tactical', 3: 'Diagnostic', 4: 'Strategic' }[r.level];
    var col = { 2: 'var(--accent-blue)', 3: 'var(--status-amber)', 4: '#A855F7' }[r.level];
    var c = r.camp ? camp(r.camp) : null;
    var dots = ''; for (var i = 1; i <= 5; i++) dots += '<i style="' + (i <= r.conf ? 'background:' + col : '') + '"></i>';
    var confName = r.conf >= 5 ? 'High' : r.conf >= 3 ? 'Medium' : 'Low';
    return '<article class="rec l' + r.level + '" id="rec-' + r.id + '" style="animation-delay:' + (idx * 80) + 'ms">' +
      '<div class="spread"><span class="lvl" style="color:' + col + '">' + lvlName + '</span>' + (c ? '<a class="chip chip-blue" href="#/campaigns/' + c.id + '/insights">' + esc(c.name) + '</a>' : '<span class="chip">All campaigns · 90 days</span>') + '</div>' +
      '<div class="action">' + esc(r.action) + '</div>' +
      '<div><div class="label">Why</div><div class="small" style="font-size:14px;margin-top:4px">' + esc(r.why) + '</div></div>' +
      collapsible('Evidence', '<ul>' + r.evidence.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' + (r.memory ? '<button class="chip chip-blue" style="margin-top:10px;cursor:pointer" data-act="memory">' + ic('clock', 11) + ' Based on campaign history</button>' : '')) +
      collapsible('Diagnosis', '<p class="small" style="margin:8px 0 0">' + esc(r.diagnosis) + '</p>') +
      '<div class="form-grid" style="gap:12px"><div><div class="label">Expected outcome</div><div class="small" style="margin-top:4px">' + esc(r.outcome) + '</div></div><div><div class="label">Risk</div><div class="small" style="margin-top:4px">' + esc(r.risk) + '</div></div></div>' +
      '<div class="rec-foot"><span>Confidence <span class="conf">' + dots + '</span> ' + confName + '</span><span>Next step: <span style="color:var(--text-primary)">' + esc(r.next) + '</span></span><span>Why now: ' + esc(r.whynow) + '</span></div>' +
      '<div class="row"><button class="btn btn-primary disabled" disabled title="Autopilot arrives in v2">Apply (Coming Soon)</button><button class="btn btn-ghost" data-act="dismissRec" data-id="' + r.id + '">Dismiss</button></div>' +
      '</article>';
  }
  function collapsible(label, body) {
    return '<div><button class="collapse-h" data-act="collapse"><span class="label">' + label + '</span>' + ic('chev', 12) + '</button><div class="collapse-b">' + body + '</div></div>';
  }
  function monitoringCard() {
    return '<article class="rec mon"><span class="lvl muted">Monitoring</span>' +
      '<div class="italic" style="font:500 15px var(--f-display);font-style:italic">Conversion on refer-a-friend has declined 8% — monitoring</div>' +
      '<div class="small">The campaign has generated 23 leads this period. The sample is too small to confidently recommend a change.</div>' +
      '<div class="small">Camplo will reassess after 100 additional leads or 7 days — whichever comes first.</div>' +
      '<div class="meta row"><a class="chip chip-blue" href="#/campaigns/ref/insights">Customer Referral Drive</a><span class="ts">4 hours ago</span></div></article>';
  }

  // ---------- Screen 2: Lead Inbox ----------
  function leadInbox() {
    var total = D.leads.length, resp = responded().length, not = total - resp;
    return '<div class="page">' +
      '<div class="page-head"><div><h1 class="h1">Lead Inbox</h1><div class="watching">' + ic('brain', 14) + ' Watching your Lead Inbox</div></div></div>' +
      '<div class="kpis">' +
      '<div class="kpi"><div class="label">Total leads</div><div class="display">' + total + '</div><div class="kpi-sub">Last 24 hours · all campaigns</div></div>' +
      '<div class="kpi"><div class="label">Responded</div><div class="display green">' + resp + '</div><div class="kpi-sub">' + Math.round(resp / total * 100) + '% acknowledgment rate</div></div>' +
      '<div class="kpi dominant"><div class="label" style="color:var(--status-red)">Not responded</div><div class="display red">' + not + '</div><div class="kpi-sub"><span class="red">' + overdueLeads().length + ' overdue</span> · customers are waiting right now</div></div>' +
      '</div>' + leadFilters(true) + '<div id="leadTable">' + leadTable(filteredLeads()) + '</div></div>';
  }
  function leadFilters(withCampaign) {
    var f = S.leadFilter;
    function sel(k, opts) { return '<select class="select" data-filter="' + k + '">' + opts.map(function (o) { return '<option value="' + o[0] + '"' + (f[k] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'; }
    return '<div class="filters">' +
      sel('status', [['all', 'All statuses'], ['not', 'Not responded'], ['overdue', 'Overdue'], ['unassigned', 'Unassigned'], ['responded', 'Responded']]) +
      (withCampaign ? sel('campaign', [['all', 'All campaigns']].concat(D.campaigns.map(function (c) { return [c.id, c.name]; }))) : '') +
      sel('assignee', [['all', 'Anyone'], ['me', 'Assigned to me'], ['none', 'Unassigned']].concat(D.team.map(function (u) { return [u.id, u.name]; }))) +
      sel('sort', [['newest', 'Newest first'], ['waiting', 'Longest waiting']]) +
      '<span class="grow"></span><span class="ts" id="leadCount"></span></div>';
  }
  function filteredLeads(campId) {
    var f = S.leadFilter;
    var list = D.leads.filter(function (l) {
      if (campId && l.campaign !== campId) return false;
      if (!campId && f.campaign !== 'all' && l.campaign !== f.campaign) return false;
      if (f.status === 'not' && l.respondedAt) return false;
      if (f.status === 'responded' && !l.respondedAt) return false;
      if (f.status === 'overdue' && !isOverdue(l)) return false;
      if (f.status === 'unassigned' && (l.assignee || l.respondedAt)) return false;
      if (f.assignee === 'me' && l.assignee !== D.me) return false;
      if (f.assignee === 'none' && l.assignee) return false;
      if (['all', 'me', 'none'].indexOf(f.assignee) < 0 && l.assignee !== f.assignee) return false;
      return true;
    });
    list.sort(f.sort === 'waiting' ? function (a, b) { return (a.respondedAt ? 1 : 0) - (b.respondedAt ? 1 : 0) || a.arrived - b.arrived; } : function (a, b) { return b.arrived - a.arrived; });
    return list;
  }
  function leadTable(list, hideCampaign) {
    if (!list.length) return '<div class="table-wrap">' + (D.leads.length ? empty('search', 'No leads match these filters.', '', '<button class="btn btn-ghost" data-act="clearFilters">Clear filters</button>') : empty('inbox', 'No leads yet.', 'Leads will appear when your pages receive submissions.')) + '</div>';
    return '<div class="table-wrap"><table><thead><tr><th>Lead</th>' + (hideCampaign ? '' : '<th>Campaign</th>') + '<th>Assignee</th><th>Seen</th><th>Status</th><th style="width:80px">Lifecycle</th></tr></thead><tbody>' +
      list.map(function (l) { return leadRow(l, hideCampaign); }).join('') + '</tbody></table><div class="table-foot">All ' + list.length + ' leads loaded</div></div>';
  }
  function leadRow(l, hideCampaign) {
    var c = camp(l.campaign), od = isOverdue(l), open = !l.respondedAt;
    var assignee = !l.assignee ? '<span class="muted">Unassigned</span>' : l.assignee === D.me ? '<span class="row">' + av(l.assignee, 24) + ' You</span>' : (open ? '<span class="muted">Assigned to ' + esc(first(l.assignee)) + '</span>' : '<span class="row">' + av(l.assignee, 24) + esc(user(l.assignee).name) + '</span>');
    var status;
    if (l.respondedAt) status = '<span class="green" style="font-weight:500">Responded</span> <span class="ts">in ' + secs(Math.round((l.respondedAt - (l.assignedAt || l.arrived)) / 1000)) + '</span>';
    else if (od) status = '<div class="row"><span class="overdue-t breach" data-since="' + l.arrived + '"></span>' + (canRespond(l) ? respondBtn(l, true) : '') + '</div>';
    else if (canRespond(l)) status = respondBtn(l);
    else status = '<span class="amber" style="font-weight:500">Pending</span> <span class="ts" data-since="' + l.arrived + '"></span>';
    return '<tr class="' + (od ? 'breached' : '') + '" data-go="campaigns/' + l.campaign + '/leads/' + l.id + '">' +
      '<td><div class="lead-cell"><span class="dot-slot">' + (open && (!l.assignee || !l.respondedAt) ? '<span class="dot dot6 o pulse-orange"></span>' : '') + '</span><div><div class="nm">' + esc(l.name) + (l.vip ? ' <span class="chip" style="height:18px;font-size:10px">VIP</span>' : '') + '</div><div class="mono muted" style="color:var(--text-muted)">' + l.id + '</div></div></div></td>' +
      (hideCampaign ? '' : '<td class="sec">' + esc(c.name) + '</td>') +
      '<td>' + assignee + '</td>' +
      '<td class="ts" data-ago="' + l.arrived + '"></td>' +
      '<td>' + status + '</td>' +
      '<td><button class="lc-btn tip ' + (l.external ? 'ext' : '') + '" data-tip="View Lifecycle" data-act="lifecycle" data-id="' + l.id + '">' + lifeIcon() + '</button></td></tr>';
  }
  function respondBtn(l, sm) { return '<button class="btn btn-primary ' + (sm ? 'btn-sm' : 'btn-sm') + '" data-act="respond" data-id="' + l.id + '">Respond</button>'; }

  // ---------- Screen 3–10: Campaign detail ----------
  function campaignDetail(id, tab) {
    var c = camp(id);
    if (!c) return '<div class="page">' + empty('target', 'Campaign not found.', '', '<a class="btn btn-ghost" href="#/dashboard">Back</a>') + '</div>';
    var tabs = [['overview', 'Overview'], ['leads', 'Leads'], ['pages', 'Pages'], ['insights', 'Insights'], ['forms', 'Forms', 1], ['notes', 'Notes'], ['meeting', 'Meeting Notes', 1], ['logs', 'Logs'], ['sla', 'SLA']];
    if (c.status === 'COMPLETE') tabs.push(['retrospective', 'Retrospective']);
    var head = '<div class="camp-head">' +
      '<div class="crumb"><a href="#/dashboard">' + ic('back', 13) + ' Campaign</a> / ' + esc(user(c.owner).name) + ' <span class="mono" style="color:var(--text-muted);margin-left:8px">' + c.cid + '</span></div>' +
      '<div class="spread wrap" style="margin-top:14px"><div class="row gap12 editable"><h1 class="h1">' + esc(c.name) + '</h1><button class="close pen" data-act="toast" data-msg="Rename is inline — click the title" aria-label="Edit name">' + ic('pen', 14) + '</button></div>' +
      '<div class="row"><button class="btn btn-ghost" data-act="share" data-id="' + c.id + '">' + ic('share', 14) + ' Client view</button>' + (c.status !== 'COMPLETE' ? '<button class="btn btn-ghost" data-act="markComplete" data-id="' + c.id + '">Mark Campaign Complete</button>' : '') + '</div></div>' +
      '<div class="camp-meta">' + (c.status === 'COMPLETE' ? '<span class="badge b-blue">Complete</span>' : healthBadge(c.health)) + '<span class="sep"></span>' +
      '<span>Speed-to-lead <b class="' + speedClass(c.avgResp) + '">' + secs(c.avgResp) + '</b></span>' + (c.budget ? '<span class="sep"></span><span>CPL <b class="' + (c.id === 'bf26' ? 'amber' : '') + '">' + naira(c.id === 'bf26' ? 14860 : c.budget * 0.4 / c.leads) + '</b></span>' : '') +
      '<span class="sep"></span><span>Started ' + fmtDate(new Date(c.start).getTime()) + '</span><span class="sep"></span><span class="row">' + av(c.owner, 20) + esc(user(c.owner).name) + '</span><span class="sep"></span><span>' + (c.end ? (Math.round((new Date(c.end) - new Date(c.start)) / DAY) + ' days total') : ('Day ' + daysSince(c.start))) + '</span></div>' +
      '<nav class="subtabs">' + tabs.map(function (t) {
        return t[2] ? '<span class="subtab soon">' + t[1] + ' <span class="chip chip-soon">Soon</span></span>' : '<a class="subtab ' + (tab === t[0] ? 'active' : '') + '" href="#/campaigns/' + c.id + '/' + t[0] + '">' + t[1] + '</a>';
      }).join('') + '</nav></div>';
    var body;
    if (tab === 'leads') body = '<div class="filters">' + leadFilters(false).replace('<div class="filters">', '').replace(/<\/div>$/, '') + '</div><div id="leadTable" data-camp="' + c.id + '">' + leadTable(filteredLeads(c.id), true) + '</div>';
    else if (tab === 'insights') body = insightsTab(c);
    else if (tab === 'notes') body = '<div style="max-width:760px"><div class="h2">Notes</div><div class="small italic muted" style="margin-top:4px;color:var(--text-muted)">Notes cannot be deleted. Editable within 2 hours of posting.</div>' + notesBlock(c.id) + '</div>';
    else if (tab === 'logs') body = logsTab(c);
    else if (tab === 'retrospective') body = retroTab(c);
    else if (tab === 'pages') body = pagesTable(D.pages.filter(function (p) { return p.camp === c.id; }));
    else if (tab === 'sla') body = campaignSla(c);
    else body = overviewTab(c);
    return head + '<div class="page" style="padding-top:28px">' + body + '</div>';
  }

  function overviewTab(c) {
    var budget = '';
    if (c.budget) {
      var cpl = c.id === 'bf26' ? 14860 : Math.round(c.budget * 0.4 / c.leads);
      var over = cpl > c.cplThreshold;
      budget = '<div class="h3" style="margin-bottom:12px">Budget</div><div class="budget">' +
        '<div><div class="label">Total budget</div><b>' + naira(c.budget) + '</b></div>' +
        '<div><div class="label">Daily spend</div><b class="row" style="gap:6px">' + naira(c.daily || 0) + ' <button class="close" data-act="toast" data-msg="Daily spend updated">' + ic('pen', 12) + '</button></b></div>' +
        '<div><div class="label">Leads to date</div><b>' + c.leads + '</b></div>' +
        '<div><div class="label">CPL (live)</div><b class="' + (over ? 'amber' : 'green') + '">' + naira(cpl) + '</b></div>' +
        '<div><div class="label">CPL threshold</div><b>' + naira(c.cplThreshold) + '</b><span class="ts">' + (over ? 'Exceeded' : 'Within range') + '</span></div></div>' +
        (over ? '<div class="banner amber" style="margin-top:12px">' + ic('warn', 15) + ' CPL above your threshold — AI has been notified</div>' : '') + '<div style="height:32px"></div>';
    }
    var brief = S.editingOverview ?
      '<div class="editor-bar">' + ['B', 'I', 'U', 'S', 'H', '\u{1F517}', '•', '1.', '≡'].map(function (b, i) { var cmds = ['bold', 'italic', 'underline', 'strikeThrough', 'hiliteColor', 'createLink', 'insertUnorderedList', 'insertOrderedList', 'justifyLeft']; return '<button data-cmd="' + cmds[i] + '" title="' + cmds[i] + '">' + b + '</button>'; }).join('') + '</div>' +
      '<div class="editor prose" contenteditable="true" id="ovEditor">' + (c.brief || '<p>' + esc(c.desc) + '</p>') + '</div>' +
      '<div class="row" style="margin-top:12px"><button class="btn btn-primary" data-act="saveOverview" data-id="' + c.id + '">Save</button><button class="btn btn-ghost" data-act="cancelOverview">Cancel</button></div>'
      : '<div class="editable"><div class="spread"><div class="h3">Campaign brief</div><button class="btn btn-ghost btn-sm pen" data-act="editOverview">' + ic('pen', 13) + ' Edit</button></div>' +
      '<div class="prose" style="margin-top:12px">' + (c.brief || '<p>' + esc(c.desc) + '</p><p class="sec">Goal: keep speed-to-lead under 5 minutes and CPL inside threshold. Every lead gets a human response the same hour.</p>') + '</div></div>';
    var ins = sortInsights(D.insights.filter(function (i) { return i.camp === c.id; })).slice(0, 2);
    return '<div class="dossier"><div>' + budget + brief + '</div><aside class="rail">' +
      '<div class="glass" style="padding:20px"><div class="row" style="margin-bottom:12px"><div class="brain-ico" style="width:28px;height:28px">' + ic('brain', 14) + '</div><div class="h3">Latest intelligence</div></div><div class="feed" style="margin-top:0">' +
      (ins.length ? ins.map(insightCard).join('') : '<div class="small">No insights yet for this campaign.</div>') + '</div>' +
      '<a class="linkbtn" style="display:inline-block;margin-top:12px" href="#/campaigns/' + c.id + '/insights">All insights →</a></div>' +
      '<div class="card"><div class="label">Lead journey</div>' + funnel(c) + '</div></aside></div>';
  }
  function funnel(c) {
    var n = c.leads, rows = [['Leads received', n], ['Responded', Math.round(n * 0.955)], ['Opportunities', Math.round(n * 0.39)], ['Appointments', Math.round(n * 0.22)], ['Won', Math.round(n * 0.07)]];
    return rows.map(function (r, i) { return '<div style="margin-top:12px"><div class="spread small"><span>' + r[0] + '</span><b style="color:var(--text-primary)">' + r[1] + '</b></div><div class="progress" style="margin-top:6px"><i style="width:' + Math.round(r[1] / n * 100) + '%;background:' + (i === 4 ? 'var(--accent-orange)' : 'var(--accent-blue)') + '"></i></div></div>'; }).join('');
  }

  function insightsTab(c) {
    var cats = ['All', 'SLA', 'Spend', 'Performance', 'Engagement'];
    var list = D.insights.filter(function (i) { return (i.camp === c.id || c.id === 'all') && (S.insightFilter === 'All' || i.cat === S.insightFilter); });
    var recs = D.recs.filter(function (r) { return r.camp === c.id && !r.dismissed; });
    var body;
    if (!list.length && !recs.length) body = empty('brain', 'No insights yet.', 'Camplo will surface intelligence as your campaign generates activity.');
    else {
      var pri = list.filter(function (i) { return i.priority; });
      var rest = list.filter(function (i) { return !i.priority; });
      var groups = {}; var order = [];
      sortInsights(rest).forEach(function (i) { var k = dayLabel(i.t); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(i); });
      body = '<div class="feed">' + pri.map(insightCard).join('') + recs.map(recCard).join('') + (c.id === 'ref' ? monitoringCard() : '') + '</div>' +
        order.map(function (k) { return '<div class="daygroup"><div class="section-label"><span class="label">' + k + '</span></div><div class="feed" style="margin-top:0">' + groups[k].map(insightCard).join('') + '</div></div>'; }).join('');
    }
    return '<div style="max-width:760px"><div class="spread wrap"><div><div class="h2">Insights</div><div class="italic small" style="color:var(--text-muted)">Powered by Camplo Intelligence</div></div></div>' +
      '<div class="pills" style="margin:20px 0">' + cats.map(function (k) { return '<button class="pill ' + (S.insightFilter === k ? 'active' : '') + '" data-act="ifilter" data-v="' + k + '">' + k + '</button>'; }).join('') + '</div>' + body + '</div>';
  }

  function notesBlock(campId, leadId) {
    var list = D.notes.filter(function (n) { return leadId ? n.lead === leadId : n.camp === campId && !n.lead; });
    D.teamNotes.forEach(function (t) { if ((leadId && t.lead === leadId) || (!leadId && t.camp === campId)) list.push(Object.assign({ team: true }, t)); });
    list.sort(function (a, b) { return b.t - a.t; });
    var items = list.length ? list.map(noteItem).join('') : empty('note', 'No notes yet. Be the first to add one.', '');
    return '<div style="margin-top:12px">' + items + '</div>' +
      '<div class="note-compose"><textarea class="input" rows="2" id="noteInput" placeholder="Add a note... Notes cannot be deleted once posted."></textarea>' +
      '<div class="spread"><span class="ts">⌘/Ctrl + Enter to post</span><button class="btn btn-primary" id="postNote" data-act="postNote" data-camp="' + (campId || '') + '" data-lead="' + (leadId || '') + '" disabled>Post Note</button></div></div>';
  }
  function noteItem(n) {
    var ext = n.author === 'ext';
    var mine = n.author === D.me, left = 2 * HOUR - (Date.now() - n.t);
    var canEdit = mine && left > 0 && !n.team;
    var who = ext ? '<span class="avatar s32" style="color:var(--accent-blue)">' + ic('note', 14) + '</span>' : av(n.author);
    if (S.editNote === n.id) {
      return '<div class="note">' + who + '<div class="grow"><div class="who">' + esc(user(n.author).name) + '</div><textarea class="input" id="editNoteInput" style="margin-top:8px">' + esc(n.body) + '</textarea><div class="row" style="margin-top:8px"><button class="btn btn-primary btn-sm" data-act="saveNote" data-id="' + n.id + '">Save</button><button class="btn btn-ghost btn-sm" data-act="cancelNote">Cancel</button></div></div></div>';
    }
    return '<div class="note ' + (ext ? 'ext' : '') + '">' + who + '<div class="grow">' +
      '<div class="row"><span class="who">' + (ext ? 'Meeting note' : esc(user(n.author).name)) + '</span>' + (ext ? '<span class="chip chip-blue">Via ' + esc(n.via) + '</span>' : '') + (n.team ? '<span class="chip chip-blue">Team Note → ' + n.to.map(function (u) { return '@' + first(u); }).join(' ') + '</span>' : '') +
      '<span class="ts" data-ago="' + n.t + '"></span>' + (canEdit ? '<button class="edit-pen" data-act="editNote" data-id="' + n.id + '" aria-label="Edit note">' + ic('pen', 13) + '</button>' : '') + '</div>' +
      (n.edited ? '<div class="edited">Edited · ' + new Date(n.edited).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</div>' : '') +
      (canEdit ? '<div class="editable-for" data-until="' + (n.t + 2 * HOUR) + '" data-prefix="Editable for "></div>' : '') +
      '<div class="body">' + esc(n.body) + '</div></div></div>';
  }

  function logsTab(c) {
    var entries = [
      [15 * MIN, 'u2', 'Responded to <b>Chidi Eze</b> in 3m 42s'], [40 * MIN, 'u2', 'Added a note on the campaign'], [58 * MIN, null, 'Webhook on <span class="mono">bf-bundle-b</span> stopped receiving events'],
      [2 * HOUR, 'u1', 'Assigned <b>Folake Ade</b> to Sarah Okafor'], [5 * HOUR, 'u1', 'Paused ad set <b>Video 15s</b> (logged manually)'], [26 * HOUR, 'u3', 'Responded to 11 leads'],
      [27 * HOUR, null, 'Camplo raised a Priority Flag — 3 concurrent SLA breaches'], [50 * HOUR, 'u5', 'Uploaded version 2 of <span class="mono">bf-bundle-b</span>'], [74 * HOUR, 'u1', 'Changed CPL threshold to ₦12,000']
    ];
    var groups = {}, order = [];
    entries.forEach(function (e) { var k = dayLabel(Date.now() - e[0]); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(e); });
    return '<div style="max-width:860px"><div class="spread"><div class="h2">Activity Log</div><select class="select" style="width:auto"><option>Last 7 days</option><option>Last 30 days</option><option>All time</option></select></div>' +
      order.map(function (k) { return '<div class="section-label"><span class="label">' + k + '</span></div>' + groups[k].map(function (e) { var ts = Date.now() - e[0]; return '<div class="log"><span class="mono">' + clock(ts) + '</span>' + (e[1] ? av(e[1], 24) : '<span class="avatar s24" style="color:var(--accent-blue)">' + ic('brain', 12) + '</span>') + '<span>' + e[2] + '</span></div>'; }).join(''); }).join('') + '</div>';
  }

  function retroTab(c) {
    return '<div style="max-width:960px"><div class="spread wrap"><div><h1 class="h1">Campaign Retrospective</h1><div class="small italic" style="color:var(--text-muted);margin-top:4px">Generated automatically when campaign was marked complete</div></div>' +
      '<button class="btn btn-primary" data-act="pdf">' + ic('download', 15) + ' Download PDF</button></div>' +
      '<div class="glass" style="padding:32px;margin-top:24px">' +
      '<div class="spread"><div><div class="h2">' + esc(c.name) + '</div><div class="small">1 Jun 2026 – 31 Aug 2026 · 91 days active</div></div><span class="badge b-blue">Complete</span></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin:28px 0 0">' +
      '<div><div class="label">Total leads</div><div class="display">391</div></div>' +
      '<div><div class="label">Avg speed-to-lead</div><div class="display green">4m 32s</div><div class="kpi-sub">5 min target · you averaged 4m 32s</div></div>' +
      '<div><div class="label">Acknowledgment rate</div><div class="display">97%</div></div>' +
      '<div><div class="label">Cost per lead</div><div class="display">₦8,184</div></div></div>' +
      '<div class="divider" style="margin:28px 0"></div>' +
      '<div class="form-grid"><div><div class="label">Best performing page</div><div class="h3" style="margin-top:6px">summer-main</div><div class="green small">11.2% conversion</div></div><div><div class="label">Worst performing page</div><div class="h3" style="margin-top:6px">summer-google-lp</div><div class="red small">2.9% conversion</div></div></div>' +
      '<div class="divider" style="margin:28px 0"></div><div class="label">AI observation</div>' +
      '<p style="font:italic 500 16px/1.7 var(--f-display);color:var(--text-secondary);margin:12px 0 0">Leads that received a response inside five minutes were 3.4× more likely to reach “Won” than those answered after an hour — and every one of the late responses clustered on weekends. Google traffic produced cheaper leads but converted to opportunities at a third of Meta’s rate. For the next campaign, staff one person on Saturday afternoons before increasing spend, and judge channels on cost per qualified opportunity rather than cost per lead.</p>' +
      '<div class="ts" style="margin-top:28px;text-align:center">Powered by Camplo <span class="chip chip-plan" data-act="upgrade" data-plan="Agency" style="margin-left:6px">Agency · white-label</span></div></div></div>';
  }

  function campaignSla(c) {
    var leads = D.leads.filter(function (l) { return l.campaign === c.id; });
    var od = leads.filter(isOverdue);
    return '<div class="sla-grid"><div class="card"><div class="label">Avg response time</div><div class="display ' + speedClass(c.avgResp) + '" style="margin-top:8px">' + secs(c.avgResp) + '</div><div class="small" style="margin-top:8px">Threshold ' + D.slaMinutes + 'm · ' + leads.filter(function (l) { return l.respondedAt; }).length + ' of ' + leads.length + ' responded</div></div>' +
      '<div class="card"><div class="spread"><div class="label">Overdue now</div><span class="badge b-red">' + od.length + '</span></div>' + (od.length ? od.map(overdueRow).join('') : '<div class="empty" style="padding:24px"><div class="check-big">' + ic('check', 28) + '</div><div class="h">No overdue leads right now.</div></div>') + '</div></div>';
  }

  // ---------- Screen 5: Lead Dossier ----------
  function dossier(campId, leadId) {
    var l = byId(D.leads, leadId); if (!l) return '<div class="page">' + empty('inbox', 'Lead not found.', '', '<a class="btn btn-ghost" href="#/leads">Back to Lead Inbox</a>') + '</div>';
    var c = camp(l.campaign);
    var thr = D.slaMinutes * 60;
    var breaching = !l.respondedAt && isOverdue(l);
    var respStart = l.assignedAt || l.arrived;
    var head = '<a class="crumb" href="#/leads">' + ic('back', 13) + ' Back to Lead Inbox</a>' +
      '<div class="spread wrap" style="margin-top:16px"><h1 class="h1">Lead Dossier</h1>' +
      (l.respondedAt ? '<span class="badge b-green xl">Responded</span>' : canRespond(l) ? '<button class="btn btn-primary" data-act="respond" data-id="' + l.id + '" data-big="1">' + ic('check', 15) + ' Mark as Responded</button>' : '<span class="small">Assigned to ' + esc(user(l.assignee).name) + '</span>') + '</div>' +
      (l.respondedAt ? '' : '<div style="margin-top:12px"><span class="badge b-red xl b-bold">Not responded</span></div>') +
      '<div class="dossier-name">' + esc(l.name) + '</div>' +
      '<div class="sec">' + esc(l.email) + ' · ' + esc(l.phone) + '</div>' +
      '<div class="sla-card ' + (breaching ? 'breaching' : '') + '">' +
      '<div><div class="label">Customer waiting</div><div class="timer big" data-since="' + l.arrived + '" data-stop="' + (l.respondedAt || '') + '" data-thr="' + thr + '" data-sec="1"></div><div class="ts">Since arrival · ' + clock(l.arrived) + ' · threshold ' + D.slaMinutes + 'm</div></div>' +
      '<div class="vr"></div>' +
      '<div><div class="label">Response time <span style="text-transform:none;letter-spacing:0;font-size:11px">\u00B7 ' + (l.assignedAt ? 'from assignment' : 'from claim') + '</span></div><div class="timer big" data-since="' + respStart + '" data-stop="' + (l.respondedAt || '') + '" data-thr="' + thr + '" data-sec="1"></div><div class="ts">' + (l.respondedAt ? 'Stopped at ' + clock(l.respondedAt) : l.assignee ? 'Owned by ' + esc(user(l.assignee).name) : 'Open to all team members') + '</div></div></div>';

    var u = l.utm;
    var attr = '<section class="dsec"><div class="h2">Attribution</div><dl class="kv">' +
      '<dt>Source Page</dt><dd><a href="#/pages">' + esc(l.page) + '</a></dd>' +
      '<dt>Collection</dt><dd>' + esc(c.name) + '</dd>' +
      '<dt>Source System</dt><dd>' + esc(l.source) + '</dd>' +
      '<dt>Source Identifier</dt><dd class="mono">' + esc(l.sourceId) + '</dd>' +
      '<dt>Received At</dt><dd>' + new Date(l.arrived).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '</dd>' +
      (u ? ['source', 'medium', 'campaign', 'content', 'term'].filter(function (k) { return u[k]; }).map(function (k) { return '<dt>UTM ' + k[0].toUpperCase() + k.slice(1) + '</dt><dd class="mono">' + esc(u[k]) + '</dd>'; }).join('') : '') +
      '</dl>' + (u ? '' : '<div class="small" style="margin-top:12px">No UTM data captured for this lead.</div>') + '</section>';

    var audit = '<section class="dsec"><div class="h2">Audit Trail <span style="margin-left:auto">' + (l.respondedAt ? '<span class="badge b-green">Responded</span>' : '<span class="badge b-red">Not responded</span>') + '</span></div><ul class="audit">' +
      auditEvents(l).map(function (e) { return '<li><span class="mono">' + clock(e[0]) + '</span><span>' + e[1] + '</span><span class="ts">' + e[2] + '</span></li>'; }).join('') + '</ul></section>';

    var lc = '<section class="dsec"><div class="h2">Lifecycle</div>' + (l.external ? timeline(l) : empty('link', 'No external events yet.', 'Connect a CRM via webhook to see the full lead journey.', '<a class="btn btn-ghost" href="#/settings/integrations">Connect</a>')) + '</section>';
    var nc = D.notes.filter(function (n) { return n.lead === l.id; }).length + D.teamNotes.filter(function (t) { return t.lead === l.id; }).length;
    var notes = '<section class="dsec"><div class="h2">Notes <span class="chip">' + nc + '</span></div>' + notesBlock(null, l.id) + '</section>';

    var rail = '<aside class="rail">' +
      '<div class="glass" style="padding:20px"><div class="row" style="margin-bottom:10px"><div class="brain-ico" style="width:28px;height:28px">' + ic('brain', 14) + '</div><div class="h3">What Camplo sees</div></div>' +
      '<div class="small" style="line-height:1.6">' + (l.respondedAt ? 'Responded inside the window. Leads answered this fast on <b>' + esc(c.name) + '</b> reach “Meeting” 3.4× more often.' : 'Every minute past 5 lowers the chance of contact. Leads on this campaign answered after 30 minutes convert <b class="red">71% less</b>. ' + (l.vip ? 'This is a <b>VIP page</b> lead.' : '')) + '</div></div>' +
      '<div class="card"><div class="label">Campaign</div><a class="h3" style="display:block;margin-top:6px;color:var(--text-primary)" href="#/campaigns/' + c.id + '/overview">' + esc(c.name) + '</a><div style="margin-top:8px">' + healthBadge(c.health) + '</div></div>' +
      '<div class="card"><div class="label" style="margin-bottom:8px">Reassign (owner)</div><select class="select" data-act-change="reassign" data-id="' + l.id + '"><option value="">Choose team member…</option>' + D.team.map(function (t) { return '<option value="' + t.id + '"' + (l.assignee === t.id ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') + '</select><div class="ts" style="margin-top:8px">Response timer resets for the new assignee. Customer-waiting timer never resets.</div></div>' +
      '</aside>';
    return '<div class="page"><div class="dossier"><div>' + head + attr + audit + lc + notes + '</div>' + rail + '</div></div>';
  }
  function auditEvents(l) {
    var e = [[l.arrived, 'Lead received', 'Camplo']];
    if (l.assignedAt) e.push([l.assignedAt, 'Assigned to ' + esc(user(l.assignee).name) + ' — by Marcus (Owner)', 'Camplo']);
    else e.push([l.arrived, 'Available to all team members', 'Camplo']);
    if (l.reassigned) e.push([l.reassigned.t, 'Reassigned from ' + esc(user(l.reassigned.from).name) + ' to ' + esc(user(l.assignee).name) + ' by Marcus', 'Camplo']);
    if (l.respondedAt) e.push([l.respondedAt, 'Responded — ' + esc(user(l.assignee).name) + (l.assignedAt ? ' (acknowledged)' : ' (claimed and acknowledged)'), 'Camplo']);
    return e;
  }
  function lifeEvents(l) {
    var ev = [[l.arrived, 'Lead received', 'Camplo', 'c']];
    if (l.respondedAt) ev.push([l.respondedAt, 'Responded — ' + first(l.assignee), 'Camplo', 'c']);
    if (l.external) {
      var crm = l.source === 'GoHighLevel' ? 'GoHighLevel CRM' : 'Twenty CRM';
      var base = l.respondedAt || l.arrived;
      ev.push([base + 7 * MIN, 'Person created', crm, 'e']);
      if (Date.now() - l.arrived > 2 * HOUR) ev.push([base + 28 * MIN, 'Opportunity created', crm, 'e']);
      if (Date.now() - l.arrived > 6 * HOUR) ev.push([base + 3.5 * HOUR, 'Opportunity → Meeting', crm, 'e']);
      if (Date.now() - l.arrived > 12 * HOUR) ev.push([base + 9 * HOUR, 'Appointment booked', crm, 'm']);
      if (Date.now() - l.arrived > 20 * HOUR) ev.push([base + 19 * HOUR, 'WON', crm, 'm', 1]);
    }
    return ev.filter(function (x) { return x[0] <= Date.now(); });
  }
  function timeline(l) {
    return '<ul class="timeline">' + lifeEvents(l).map(function (e) {
      var d = new Date(e[0]), t = Date.now() - e[0] > DAY ? d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) : clock(e[0]);
      return '<li class="' + (e[4] ? 'ms' : '') + '"><span class="t">' + t + '</span><span class="tdot ' + e[3] + '"></span><span class="ev" style="' + (e[3] === 'm' ? 'font-weight:700' : '') + '">' + e[1] + '</span><span class="src">' + e[2] + '</span></li>';
    }).join('') + '</ul>';
  }

  // ---------- Screen 11: Pages ----------
  function hookIndicator(p) {
    var m = { healthy: ['g', '', 'Live · Last ping <span data-ago="' + p.ping + '"></span>'], warning: ['a', 'pulse-slow', 'No data in 2h'], offline: ['r', 'pulse-fast', 'Offline · Last ping <span data-ago="' + p.ping + '"></span>'], never: ['m', '', 'Not connected'] }[p.hook];
    return '<span class="row" style="gap:8px"><span class="dot ' + m[0] + ' ' + m[1] + '"></span><span style="font-size:12px;color:var(--text-secondary)">' + m[2] + '</span></span>';
  }
  var ACC_AVG = 8.7;
  function pagesTable(list) {
    if (!list.length) return empty('file', 'No pages hosted yet.', 'Upload your first campaign page to get started.', '<button class="btn btn-primary" data-act="upload">Upload Page</button>');
    return list.filter(function (p) { return p.watch72; }).map(function (p) { return '<div class="banner amber" style="margin-bottom:12px"><span class="chip" style="color:var(--status-amber)">72h Watch</span><b>' + p.name + '</b> — ' + p.leads + ' leads in 31h — check setup before spending more budget</div>'; }).join('') +
      '<div class="table-wrap"><table><thead><tr><th>Page name</th><th>Campaign</th><th>Status</th><th>Webhook</th><th>Visits</th><th>Leads</th><th>Conversion</th><th style="text-align:right">Actions</th></tr></thead><tbody>' +
      list.map(function (p) {
        var conv = p.leads / p.visits * 100;
        var st = { ACTIVE: 'b-green', PAUSED: 'b-amber', ARCHIVED: 'b-grey' }[p.status];
        return '<tr data-act="pageDrawer" data-id="' + p.id + '"><td><div class="nm" style="font-weight:600">' + p.name + '</div><div class="mono" style="color:var(--text-muted)">camplo.page/' + p.name + '</div></td><td class="sec">' + esc(camp(p.camp).name) + '</td><td><span class="badge ' + st + '">' + p.status + '</span></td><td>' + hookIndicator(p) + '</td><td>' + p.visits.toLocaleString() + '</td><td>' + p.leads + '</td><td class="' + (conv >= ACC_AVG ? 'green' : 'red') + '" style="font-weight:600">' + conv.toFixed(1) + '%</td>' +
          '<td style="text-align:right"><div class="row" style="justify-content:flex-end"><button class="btn btn-ghost btn-sm" data-act="upload" title="Upload version">' + ic('upload', 13) + '</button><button class="btn btn-ghost btn-sm" data-act="toast" data-msg="' + (p.status === 'PAUSED' ? 'Page unpaused' : 'Page paused') + '">' + (p.status === 'PAUSED' ? 'Unpause' : 'Pause') + '</button><button class="btn btn-ghost btn-sm" data-act="pageMenu" data-id="' + p.id + '">' + ic('more', 14) + '</button></div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function pagesScreen() {
    var active = D.pages.filter(function (p) { return p.status === 'ACTIVE'; }).length;
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Pages</h1><div class="small" style="margin-top:6px">' + D.pages.length + ' pages hosted · ' + active + ' active · account avg conversion ' + ACC_AVG + '%</div></div><button class="btn btn-primary" data-act="upload">' + ic('upload', 15) + ' Upload a new page</button></div>' +
      '<div class="filters"><input class="input" placeholder="Search pages" style="width:240px;height:36px" /><select class="select"><option>All statuses</option><option>Active</option><option>Paused</option><option>Archived</option></select><select class="select"><option>All campaigns</option>' + D.campaigns.map(function (c) { return '<option>' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      pagesTable(D.pages) + '</div>';
  }
  function pageDrawer(id) {
    var p = byId(D.pages, id), bars = [62, 80, 45, 90, 71, 100, 84];
    var leads = D.leads.filter(function (l) { return l.page === p.name; });
    return drawer('w520', '<div><div class="h2">' + p.name + '</div><div class="row" style="margin-top:6px"><span class="badge ' + ({ ACTIVE: 'b-green', PAUSED: 'b-amber', ARCHIVED: 'b-grey' }[p.status]) + '">' + p.status + '</span><span class="mono">camplo.page/' + p.name + '</span><a href="#" data-act="toast" data-msg="Opens the hosted page">Open page ↗</a></div></div>',
      '<div class="label">Traffic · 7 days</div><div class="bars" style="height:120px">' + bars.map(function (b, i) { return '<div class="bar"><i style="height:' + b + '%;background:var(--accent-blue)"></i><span>' + 'MTWTFSS'[i] + '</span></div>'; }).join('') + '</div>' +
      '<div class="card" style="margin-top:24px"><div class="spread"><div><div class="label">Webhook health</div><div style="margin-top:8px">' + hookIndicator(p) + '</div></div><button class="btn btn-ghost btn-sm" data-act="testHook">Test Webhook</button></div><div class="mono" style="margin-top:12px">https://in.camplo.app/wh/' + p.id + '_7f3a91</div></div>' +
      '<div class="label" style="margin:24px 0 8px">Leads from this page</div>' + (leads.length ? leads.map(function (l) { return '<div class="list-row" data-go="campaigns/' + l.campaign + '/leads/' + l.id + '" style="cursor:pointer"><span class="grow"><b>' + esc(l.name) + '</b> <span class="mono" style="color:var(--text-muted)">' + l.id + '</span></span>' + (l.respondedAt ? '<span class="green">Responded</span>' : '<span class="red" data-since="' + l.arrived + '"></span>') + '</div>'; }).join('') : '<div class="small">No leads in the last 24 hours.</div>') +
      '<div class="col gap12" style="margin-top:24px">' + (p.versions > 1 ? '<div><button class="btn btn-ghost" data-act="toast" data-msg="Rolled back to version ' + (p.versions - 1) + '">Rollback to previous version</button><div class="ts" style="margin-top:4px">Stored for 30 days</div></div>' : '') + '<button class="btn btn-ghost" style="align-self:flex-start" data-act="toast" data-msg="Custom domains: add a CNAME to pages.camplo.app">Connect custom domain</button></div>');
  }

  // ---------- Screen 12: SLA ----------
  function overdueRow(l) {
    return '<div class="list-row"><div class="grow"><a href="#/campaigns/' + l.campaign + '/leads/' + l.id + '" style="color:var(--text-primary);font-weight:600">' + esc(l.name) + '</a><div class="ts">' + l.page + ' · ' + esc(camp(l.campaign).name) + '</div></div><span class="overdue-t breach" style="font-size:15px" data-since="' + l.arrived + '"></span><span class="row" style="width:140px">' + (l.assignee ? av(l.assignee, 24) + esc(first(l.assignee)) : '<span class="muted">Unassigned</span>') + '</span><button class="btn btn-primary btn-sm" data-act="notify" data-id="' + l.id + '">Notify Now</button></div>';
  }
  function slaScreen() {
    var tabs = '<nav class="settings-tabs"><button class="subtab ' + (S.slaTab === 'live' ? 'active' : '') + '" data-act="slaTab" data-v="live">Live Status</button><button class="subtab ' + (S.slaTab === 'config' ? 'active' : '') + '" data-act="slaTab" data-v="config">Configuration</button></nav>';
    var head = '<div class="page-head"><div><h1 class="h1">SLA</h1><div class="watching">' + ic('brain', 14) + ' Monitoring 10 handoff points from page visit to closed deal</div></div></div>';
    return '<div class="page">' + head + tabs + (S.slaTab === 'live' ? slaLive() : slaConfig()) + '</div>';
  }
  function slaLive() {
    var sp = avgResponse(), od = overdueLeads();
    var days = [['Mon', 'g', 70], ['Tue', 'g', 55], ['Wed', 'a', 85], ['Thu', 'g', 60], ['Fri', 'r', 100], ['Sat', 'r', 92], ['Sun', 'a', 78]];
    var colors = { g: 'var(--status-green)', a: 'var(--status-amber)', r: 'var(--status-red)' };
    var dayPanel = S.slaDay != null ? '<div class="banner blue" style="margin-top:16px">' + ic('clock', 15) + '<div><b>' + days[S.slaDay][0] + '</b> — ' + [31, 28, 44, 26, 52, 39, 35][S.slaDay] + ' leads · avg response ' + ['3m 50s', '3m 12s', '9m 40s', '4m 05s', '38m 20s', '31m 02s', '12m 44s'][S.slaDay] + ' · ' + [0, 0, 1, 0, 4, 3, 1][S.slaDay] + ' breaches</div><button class="x" data-act="slaDay" data-v="">×</button></div>' : '';
    return '<div class="sla-grid">' +
      '<div class="card"><div class="label">Avg response time</div><div style="font:700 56px/1 var(--f-display);margin-top:12px" class="' + speedClass(sp) + '">' + secs(sp) + '</div>' +
      '<div class="small" style="margin-top:10px">Today vs 30-day avg (6m 48s) <span class="red">' + ic('arrowUp', 12) + ' ' + secs(Math.max(0, sp - 408)) + ' slower</span></div>' +
      '<div class="divider"></div>' + D.team.map(function (u) { var better = u.week <= u.avg30; return '<div class="list-row">' + av(u.id, 28) + '<span class="grow">' + esc(u.name) + '</span><span class="ts" style="width:90px">This week</span><b class="' + (better ? 'green' : 'red') + '" style="width:80px">' + secs(u.week) + '</b><span class="ts" style="width:110px">30d ' + secs(u.avg30) + '</span></div>'; }).join('') + '</div>' +
      '<div class="col gap24"><div class="card"><div class="label">SLA trend · 7 days</div><div class="bars">' + days.map(function (d, i) { return '<div class="bar ' + (S.slaDay === i ? 'sel' : '') + '" data-act="slaDay" data-v="' + i + '"><i style="height:' + d[2] + '%;background:' + colors[d[1]] + '"></i><span>' + d[0] + '</span></div>'; }).join('') + '</div>' + dayPanel + '</div>' +
      '<div class="card"><div class="spread"><div class="label">Overdue now</div><span class="badge b-red">' + od.length + '</span></div>' + (od.length ? od.map(overdueRow).join('') : '<div class="empty" style="padding:24px"><div class="check-big">' + ic('check', 28) + '</div><div class="h">No overdue leads right now.</div></div>') + '</div></div></div>' +
      '<div class="card" style="margin-top:24px"><div class="spread"><div><div class="h3">Cross-tool SLA breaches</div><div class="small">Twenty CRM, GoHighLevel, Brevo, Meta Ads connected</div></div></div>' +
      [['CRM', 'b-purple', 'Chidi Eze', 'Not moved to “Contacted” within 24h', 'u2', '3h 12m'], ['Email', 'b-blue', 'Grace Lawal', 'Not enrolled in follow-up sequence within 2h', 'u3', '1h 40m'], ['Ad Spend', 'b-amber', 'bf-vip-early', 'Spending 31h with 4 leads', null, '—']].map(function (b) {
        return '<div class="list-row"><span class="badge nodot ' + b[1] + '" style="width:80px;justify-content:center">' + b[0] + '</span><b style="width:140px">' + b[2] + '</b><span class="grow small">' + b[3] + '</span><span class="row" style="width:120px">' + (b[4] ? av(b[4], 24) + first(b[4]) : '<span class="muted">—</span>') + '</span><span class="overdue-t" style="width:70px">' + b[5] + '</span><button class="btn btn-ghost btn-sm" data-go="leads">View Lead</button></div>';
      }).join('') + '</div>' +
      '<div class="card" style="margin-top:24px"><div class="h3">Team SLA health</div><div class="small" style="margin-bottom:8px">Data only. No ranking.</div>' +
      D.team.map(function (u) { return '<div class="list-row">' + av(u.id, 28) + '<span class="grow">' + esc(u.name) + '</span><span style="width:140px">Avg ' + secs(u.week) + '</span><span style="width:140px">Ack rate ' + u.ackRate + '%</span><span style="width:110px" class="' + (u.breaches ? 'red' : 'green') + '">' + u.breaches + ' breaches</span></div>'; }).join('') + '</div>';
  }
  function slaConfig() {
    function rule(label, v, unit, on) { return '<div class="rule-row ' + (on ? '' : 'off') + '"><button class="toggle ' + (on ? 'on' : '') + '" data-act="ruleToggle"></button><span>' + label + '</span><input class="input" value="' + v + '" ' + (on ? '' : 'disabled') + ' /><select class="select" ' + (on ? '' : 'disabled') + '><option>' + unit + '</option><option>Days</option><option>Minutes</option></select></div>'; }
    function notify() { return '<div class="row wrap gap16" style="margin-top:12px"><span class="small">Notify via:</span>' + ['AI Panel', 'Email', 'Telegram', 'All'].map(function (x, i) { return '<label class="checkbox"><input type="checkbox" ' + (i < 2 ? 'checked' : '') + '/> ' + x + '</label>'; }).join('') + '</div>'; }
    function tool(logo, bg, name, method, rules) { return '<div class="intcard"><div class="spread"><div class="row"><span class="int-logo" style="background:' + bg + '">' + logo + '</span><div class="h3" style="font-size:14px">' + name + '</div></div><span class="badge b-green">Connected</span></div><div class="ts">Connection: ' + method + '</div><div class="small">After a lead is acknowledged in Camplo, flag it if:</div>' + rules + notify() + '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-act="saved">Save Changes</button></div></div>'; }
    return '<div style="max-width:960px"><div class="card"><div class="h3">Response threshold</div><div class="row wrap" style="margin-top:12px"><span class="small">Leads unacknowledged after</span><input class="input" style="width:80px" value="' + D.slaMinutes + '" id="slaMin" /><select class="select" style="width:130px"><option>Minutes</option><option>Hours</option></select><span class="small">will be marked overdue.</span><button class="btn btn-primary" data-act="saveSla">Save</button></div></div>' +
      '<div class="card" style="margin-top:16px"><div class="h3">VIP lead rules</div><div class="small">VIP pages get a tighter threshold and immediate Telegram alerts.</div>' + D.pages.slice(0, 5).map(function (p) { return '<div class="setting-row"><span class="mono">' + p.name + '</span><button class="toggle ' + (p.camp === 'prop' ? 'on' : '') + '" data-act="toggle"></button></div>'; }).join('') + '</div>' +
      '<div class="section-label"><span class="h2">Cross-Tool SLA Monitoring</span></div><div class="small italic" style="color:var(--text-muted);margin:-4px 0 16px">Monitor SLA across the entire lead journey — not just first acknowledgment.</div>' +
      '<div class="col gap16">' + tool('20', '#222', 'Twenty CRM', 'Webhook + API Key', rule('Not moved to “Contacted” stage within', 24, 'Hours', true) + rule('Not moved to “Proposal Sent” within', 72, 'Hours', true) + rule('No activity logged within', 7, 'Days', false)) +
      tool('Br', '#0B996E', 'Brevo', 'API Key', rule('Not enrolled in follow-up sequence within', 2, 'Hours', true) + rule('Open rate drops below (%) at any step', 15, '%', true) + rule('No click recorded within', 48, 'Hours', false)) +
      tool('M', '#0866FF', 'Meta Ads', 'API Key', rule('Spending with zero leads for', 72, 'Hours', true) + rule('Spend up week-on-week without lead growth (%)', 20, '%', false)) + '</div>' +
      '<div class="card" style="margin-top:16px"><div class="h3">Notification rules</div>' + D.team.map(function (u) { return '<div class="setting-row"><span class="row">' + av(u.id, 28) + esc(u.name) + '</span><span class="row"><select class="select" style="width:140px;height:34px"><option>Email</option><option>Telegram</option><option selected>Both</option></select><input class="input" style="width:100px;height:34px" value="08:00" /><button class="toggle on" data-act="toggle"></button></span></div>'; }).join('') + '</div></div>';
  }

  // ---------- Team Notes (IN1) ----------
  function teamNoteCard(t) {
    var dl = '';
    if (t.deadline) {
      var left = t.deadline - Date.now();
      var cls = t.met ? 'b-green' : left < 0 ? 'b-red' : left < HOUR ? 'b-amber' : 'b-grey';
      dl = '<span class="badge nodot ' + cls + '">' + ic('clock', 11) + ' ' + (t.met ? 'Met' : left < 0 ? 'Expired ' + ago(t.deadline) : 'Due ' + clock(t.deadline)) + '</span>';
    }
    var att = t.lead ? (function () { var l = byId(D.leads, t.lead); return '<a class="chip" href="#/campaigns/' + l.campaign + '/leads/' + l.id + '">Lead: ' + esc(l.name) + ' →</a>'; })() : t.camp ? '<a class="chip" href="#/campaigns/' + t.camp + '/notes">Campaign: ' + esc(camp(t.camp).name) + ' →</a>' : '';
    return '<article class="card" style="padding:16px;' + (!t.read && t.to.indexOf(D.me) >= 0 ? 'border-left:3px solid var(--accent-blue)' : t.deadline && !t.met && t.deadline < Date.now() ? 'border-left:3px solid var(--status-red)' : '') + '"><div class="row">' + av(t.author) + '<div class="grow"><div class="row"><b style="font-size:13px">' + esc(user(t.author).name) + '</b><span class="ts" data-ago="' + t.t + '"></span></div></div>' + dl + '</div>' +
      '<div class="row wrap" style="margin:10px 0 0 40px">' + t.to.map(function (u) { return '<span class="chip chip-blue">@' + first(u) + '</span>'; }).join('') + att + '</div>' +
      '<div style="margin:8px 0 0 40px">' + esc(t.body) + '</div></article>';
  }
  function teamNotesScreen() {
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Team Notes</h1><div class="small italic" style="color:var(--text-muted);margin-top:6px">The complete workspace record. Notes cannot be deleted. Editable within 2 hours.</div></div><a class="btn btn-ghost" href="#/me">Notes addressed to me</a></div>' +
      '<div class="dossier"><div class="col gap12">' + D.teamNotes.slice().sort(function (a, b) { return b.t - a.t; }).map(teamNoteCard).join('') + '</div>' +
      '<aside class="rail"><div class="card"><div class="h3">New team note</div><div class="field" style="margin-top:12px"><label>To</label><select class="select" id="tnTo">' + D.team.filter(function (u) { return u.id !== D.me; }).map(function (u) { return '<option value="' + u.id + '">@' + esc(u.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="margin-top:12px"><label>Attach to (optional)</label><select class="select" id="tnAttach"><option value="">Standalone</option>' + D.campaigns.map(function (c) { return '<option value="c:' + c.id + '">Campaign: ' + esc(c.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="field" style="margin-top:12px"><label>Deadline (optional)</label><select class="select" id="tnDue"><option value="">No deadline</option><option value="1">In 1 hour</option><option value="3">In 3 hours</option><option value="24">Tomorrow</option></select></div>' +
      '<textarea class="input" id="tnBody" style="margin-top:12px" placeholder="Write a note… Notes cannot be deleted once posted."></textarea><button class="btn btn-primary btn-full" style="margin-top:12px" data-act="postTeamNote">Post Team Note</button></div></aside></div></div>';
  }

  // ---------- My Performance (IN2) ----------
  function myPerformance() {
    var me = user(D.me);
    var mine = D.leads.filter(function (l) { return l.assignee === D.me && !l.respondedAt; });
    var addressed = D.teamNotes.filter(function (t) { return t.to.indexOf(D.me) >= 0; });
    return '<div class="page"><div class="page-head"><div><h1 class="h1">My Performance</h1><div class="small" style="margin-top:6px">Your own numbers, for your own growth. Not a leaderboard.</div></div></div>' +
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi"><div class="label">Speed-to-lead (week)</div><div class="display ' + speedClass(me.week) + '" style="font-size:36px">' + secs(me.week) + '</div><div class="kpi-sub green">' + ic('arrowDown', 11) + ' ' + secs(me.avg30 - me.week) + ' faster than your 30d avg</div></div>' +
      '<div class="kpi"><div class="label">Leads responded</div><div class="display" style="font-size:36px">38</div><div class="kpi-sub">This week</div></div>' +
      '<div class="kpi"><div class="label">SLA breaches</div><div class="display green" style="font-size:36px">' + me.breaches + '</div><div class="kpi-sub">This week</div></div>' +
      '<div class="kpi"><div class="label">Fastest response</div><div class="display green" style="font-size:36px">1m 08s</div><div class="kpi-sub">Tuesday · Lekki VIP lead</div></div></div>' +
      '<div class="sla-grid"><div><div class="h3" style="margin-bottom:12px">Assigned to you</div>' + leadTable(mine) + '</div><div><div class="h3" style="margin-bottom:12px">Notes addressed to you</div><div class="col gap12">' + (addressed.length ? addressed.map(teamNoteCard).join('') : empty('note', 'No notes for you.', '')) + '</div></div></div></div>';
  }

  // ---------- Settings (Screen 13 + TM1) ----------
  function settingsScreen(tab) {
    var tabs = [['team', 'Team'], ['ai', 'AI Provider'], ['telegram', 'Telegram'], ['integrations', 'Integrations'], ['webhooks', 'Webhooks & API'], ['notifications', 'Notifications']];
    var body = { team: setTeam, ai: setAI, telegram: setTelegram, integrations: setIntegrations, webhooks: setWebhooks, notifications: setNotifications }[tab] || setTeam;
    return '<div class="page"><div class="page-head"><div><h1 class="h1">Settings</h1><div class="small" style="margin-top:6px">Northbeam Growth · ' + D.plan + ' plan</div></div></div>' +
      '<nav class="settings-tabs">' + tabs.map(function (t) { return '<a class="subtab ' + (tab === t[0] ? 'active' : '') + '" href="#/settings/' + t[0] + '">' + t[1] + '</a>'; }).join('') + '</nav>' + body() + '</div>';
  }
  function setTeam() {
    return '<div class="spread" style="margin-bottom:16px"><div class="h2">Team</div><button class="btn btn-primary" data-act="invite">Invite Member</button></div>' +
      '<div class="table-wrap">' + D.team.map(function (u) {
        var rb = { OWNER: 'b-amber', ADMIN: 'b-blue', MEMBER: 'b-grey' }[u.role];
        return '<div class="member-row" data-act="member" data-id="' + u.id + '">' + av(u.id, 40) + '<b>' + esc(u.name) + '</b><span class="sec">' + esc(u.email) + '</span><span class="badge nodot ' + rb + '">' + u.role + '</span><span class="ts" data-ago="' + u.lastActive + '"></span><span class="acts">' + (u.role === 'OWNER' ? '' : '<button class="linkbtn" data-act="editRole" data-id="' + u.id + '">Edit role</button><button class="linkbtn" style="color:var(--status-red)" data-act="removeMember" data-id="' + u.id + '">Remove</button>') + '</span></div>';
      }).join('') + '</div>' +
      '<div class="section-label"><span class="label">Pending invitations</span></div><div class="table-wrap"><div class="member-row" style="cursor:default"><span class="avatar s40">@</span><b>ops@northbeam.ng</b><span class="sec">Invited 2 days ago · expires in 5 days</span><span class="badge nodot b-grey">MEMBER</span><span></span><span class="acts" style="opacity:1"><button class="linkbtn" data-act="toast" data-msg="Invitation resent">Resend</button><button class="linkbtn" data-act="toast" data-msg="Invitation cancelled">Cancel</button></span></div></div>';
  }
  function keyInput(v, id) { return '<div class="input-wrap"><input class="input mono" type="password" value="' + v + '" id="' + id + '" style="font-size:12px" /><span class="acts"><button data-act="eye" data-for="' + id + '" aria-label="Show">' + ic('eye', 14) + '</button><button data-act="copy" aria-label="Copy">' + ic('copy', 14) + '</button></span></div>'; }
  function providerBlock(title, sub, status, key, id) {
    var provs = ['Anthropic', 'OpenAI', 'DeepSeek', 'MiMo', 'Arcee', 'Google', 'GLM', 'MiniMax', 'ByteDance / Seed', 'Kimi / Moonshot', 'Other'];
    return '<div class="card"><div class="spread"><div><div class="h3">' + title + '</div>' + (sub ? '<div class="small">' + sub + '</div>' : '') + '</div>' + status + '</div><div class="form-grid" style="margin-top:16px">' +
      '<div class="field"><label>Provider</label><select class="select">' + provs.map(function (p, i) { return '<option' + ((id === 'k1' ? i === 0 : i === 1) ? ' selected' : '') + '>' + p + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label>Model name</label><input class="input" placeholder="Enter model name e.g. claude-sonnet-4-6" /></div>' +
      '<div class="field" style="grid-column:1/-1"><label>API key</label><div class="row">' + '<div class="grow">' + keyInput(key, id) + '</div><button class="btn btn-primary" data-act="verify">Verify</button></div></div></div></div>';
  }
  function setAI() {
    return '<div class="col gap16" style="max-width:860px"><div class="banner blue">' + ic('brain', 15) + ' Camplo-provided AI is on by default. Bring your own key to pay your provider directly — it does not change which features your plan includes.</div>' +
      providerBlock('Primary provider', '', '<span class="badge b-green">Connected</span>', 'sk-ant-api03-xxxxxxxxxxxxxxxx', 'k1') +
      '<div class="card"><div class="spread"><div><div class="h3">Fallback provider</div><div class="small">Fallback — used automatically if primary fails</div></div><button class="toggle" data-act="toggle"></button></div></div>' +
      '<div class="card"><div class="h3">Intelligence schedule</div><div class="row wrap" style="margin-top:12px"><span class="small">AI observations refresh every</span><input class="input" style="width:72px" value="30" /><select class="select" style="width:130px"><option>Minutes</option><option>Hours</option></select></div>' +
      '<div class="small" style="margin-top:16px">Also refresh when:</div><div class="row wrap gap16" style="margin-top:8px">' + ['SLA breach', 'Webhook silence', 'New lead batch', 'Budget threshold crossed'].map(function (x) { return '<label class="checkbox"><input type="checkbox" checked /> ' + x + '</label>'; }).join('') + '</div></div>' +
      '<div class="row" style="justify-content:flex-end"><button class="btn btn-primary" data-act="saved">Save</button></div></div>';
  }
  function setTelegram() {
    return '<div class="card" style="max-width:720px"><div class="spread"><div class="h3">Telegram alerts</div><span class="badge b-green">Connected</span></div><div class="field" style="margin-top:16px"><label>Bot token</label><div class="row"><div class="grow">' + keyInput('7349120053:AAHf-xxxxxxxxxxxxxxxxxxx', 'tg') + '</div><button class="btn btn-primary" data-act="verify">Verify & Connect</button></div></div>' +
      '<div class="setting-row" style="margin-top:12px"><div><b>Enable critical alerts</b><div class="small">SLA breaches, webhook offline, Priority Flags</div></div><button class="toggle on" data-act="toggle"></button></div>' +
      '<div class="setting-row"><div><b>Daily digest summary</b><div class="small">Every morning at 08:00</div></div><button class="toggle on" data-act="toggle"></button></div></div>';
  }
  function intCard(name, logo, bg, methods, status, modes) {
    var soon = status === 'soon';
    var badge = { on: '<span class="badge b-green">Connected</span>', off: '<span class="badge b-grey">Not connected</span>', fail: '<span class="badge b-red">Connection failed</span>', soon: '<span class="badge b-grey">Coming soon</span>' }[status];
    return '<div class="intcard ' + (soon ? 'soon' : '') + '"><div class="spread"><div class="row"><span class="int-logo" style="background:' + bg + '">' + logo + '</span><div class="h3" style="font-size:14px">' + name + '</div></div>' + badge + '</div>' +
      '<div class="row wrap">' + methods.map(function (m) { return '<span class="chip">' + m + '</span>'; }).join('') + '</div>' +
      (status === 'on' ? '<div class="row wrap">' + ['Receiving', 'Sending', 'Querying'].map(function (m, i) { var on = modes && modes[i]; return '<span class="badge ' + (on ? 'b-green' : 'b-grey') + '">' + m + '</span>'; }).join('') + '</div>' + (methods.indexOf('Webhook') >= 0 ? '<div class="row"><span class="mono grow" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">https://in.camplo.app/wh/' + name.toLowerCase().replace(/[^a-z]/g, '') + '_a91f</span><button class="close" data-act="copy">' + ic('copy', 14) + '</button></div>' : '') : '') +
      (status === 'fail' ? '<a href="#" data-act="toast" data-msg="Re-enter credentials">Re-enter credentials</a>' : '') +
      (soon ? '' : '<div class="row" style="justify-content:flex-end">' + (status === 'on' ? '<button class="btn btn-ghost btn-sm" data-act="toast" data-msg="' + name + ' disconnected">Disconnect</button>' : '<button class="btn btn-primary btn-sm" data-act="toast" data-msg="' + name + ' connected">Connect</button>') + '</div>') + '</div>';
  }
  function setIntegrations() {
    var groups = [
      ['Lead sources (inbound)', [['Systeme.io', 'S', '#2E7DF6', ['Webhook', 'API Key'], 'on', [1, 0, 1]], ['GoHighLevel', 'GH', '#1E88E5', ['Webhook', 'API Key'], 'on', [1, 1, 1]], ['Tally', 'T', '#111', ['Webhook'], 'on', [1, 0, 0]], ['Typeform', 'Tf', '#262627', ['Webhook'], 'on', [1, 0, 0]], ['Instantly (warm replies)', 'In', '#5B3DF5', ['Webhook'], 'off'], ['Custom', '{}', '#363650', ['Webhook', 'API Key'], 'off']]],
      ['CRM', [['Twenty CRM', '20', '#222', ['Webhook', 'API Key'], 'on', [1, 1, 1]], ['GoHighLevel CRM', 'GH', '#1E88E5', ['Webhook', 'API Key'], 'fail'], ['HubSpot', 'H', '#FF7A59', ['OAuth'], 'soon'], ['Salesforce', 'Sf', '#00A1E0', ['OAuth'], 'soon']]],
      ['Analytics', [['Umami', 'U', '#333', ['API Key'], 'on', [0, 0, 1]]]],
      ['Email platform', [['Brevo', 'Br', '#0B996E', ['API Key'], 'soon'], ['Mailchimp', 'Mc', '#FFE01B', ['API Key'], 'soon'], ['ActiveCampaign', 'AC', '#356AE6', ['API Key'], 'soon']]],
      ['Ad platforms', [['Meta Ads', 'M', '#0866FF', ['API Key'], 'soon'], ['Google Ads', 'G', '#34A853', ['API Key'], 'soon']]],
      ['Team communication', [['Slack', 'Sl', '#4A154B', ['OAuth'], 'soon']]]
    ];
    return groups.map(function (g) { return '<div class="section-label"><span class="label">' + g[0] + '</span></div><div class="int-grid">' + g[1].map(function (i) { return intCard.apply(null, i); }).join('') + '</div>'; }).join('');
  }
  function setWebhooks() {
    function row(url, label, last, st) { return '<div class="list-row"><span class="mono grow">' + url + '</span><span style="width:200px">' + label + '</span><span class="ts" style="width:120px">' + last + '</span><span class="badge ' + (st ? 'b-green' : 'b-red') + '">' + (st ? 'Active' : 'Failing') + '</span><button class="close" data-act="toast" data-msg="Endpoint deleted">' + ic('x', 14) + '</button></div>'; }
    return '<div class="col gap16" style="max-width:1080px"><div class="card"><div class="spread"><div><div class="h3">Inbound webhooks</div><div class="small">External tools send lead data to these URLs. Camplo receives and attributes it automatically.</div></div><button class="btn btn-primary" data-act="toast" data-msg="Inbound webhook created">Create Inbound Webhook</button></div><div style="margin-top:12px">' +
      row('https://in.camplo.app/wh/tally_bf26_a91f', 'Tally — Black Friday', '3 min ago', 1) + row('https://in.camplo.app/wh/ghl_lekki_77c2', 'GoHighLevel — Lekki', '11 min ago', 1) + row('https://in.camplo.app/wh/tally_bfb_0e14', 'Tally — bf-bundle-b', '2 hours ago', 0) + row('https://in.camplo.app/wh/sys_web_5d20', 'Systeme.io — Webinar', '1 min ago', 1) + '</div></div>' +
      '<div class="card"><div class="spread"><div><div class="h3">Outbound webhooks</div><div class="small">Camplo sends events to these URLs — lead received, SLA breached, campaign completed.</div></div><button class="btn btn-primary" data-act="toast" data-msg="Outbound webhook created">Create Outbound Webhook</button></div><div style="margin-top:12px">' +
      row('https://hooks.zapier.com/hooks/catch/1823/ab', 'sla.breached', '40 min ago', 1) + row('https://api.twenty.com/webhooks/camplo', 'lead.responded', '15 min ago', 1) + '</div></div>' +
      '<div class="card" style="opacity:0.7"><div class="spread"><div class="h3">Camplo API</div><span class="badge b-grey">Coming soon</span></div><div class="small" style="margin-top:6px">Give external tools access to your Camplo data via our API. Your developer can use this to build custom integrations on top of Camplo.</div></div></div>';
  }
  function setNotifications() {
    function r(t, s, on) { return '<div class="setting-row"><div><b>' + t + '</b>' + (s ? '<div class="small">' + s + '</div>' : '') + '</div><button class="toggle ' + (on ? 'on' : '') + '" data-act="toggle"></button></div>'; }
    return '<div class="sla-grid" style="max-width:1080px"><div class="card">' + r('Daily digest email', 'Delivered every morning at 08:00', 1) + r('SLA breach alerts', 'Email + Telegram', 1) + r('72-hour early warning', '', 1) + r('Budget threshold alerts', '', 1) + r('Webhook offline alerts', '', 1) + '</div>' +
      '<div class="glass" style="padding:20px"><div class="label">Digest preview</div><div class="h3" style="margin:8px 0 16px">Your Camplo morning digest</div><dl class="kv" style="grid-template-columns:1fr auto"><dt>Leads received yesterday</dt><dd><b>47</b></dd><dt>Acknowledged</dt><dd class="green"><b>44</b></dd><dt>Still unacknowledged</dt><dd class="red"><b>3</b></dd><dt>Top performing deployment</dt><dd class="mono">webinar-register</dd></dl></div></div>';
  }

  // ---------- Auth (A1–A7) ----------
  function authWrap(inner) { return '<div class="auth"><div class="auth-card"><div class="auth-logo">C<span>.</span></div>' + inner + '</div></div>'; }
  function authLogin() {
    return authWrap('<div style="text-align:center"><div class="h2">Welcome back</div><div class="small">See everything. Miss nothing.</div></div>' +
      '<div class="field"><label>Email</label><input class="input" id="lgEmail" type="email" value="marcus@northbeam.ng" /></div>' +
      '<div class="field"><div class="spread"><label style="font:500 12px var(--f-body);color:var(--text-secondary)">Password</label><a href="#/forgot" style="font-size:12px">Forgot password?</a></div><input class="input" id="lgPass" type="password" value="••••••••••" /></div>' +
      '<button class="btn btn-primary btn-full" data-act="login">Log in</button><div class="small" style="text-align:center">New to Camplo? <a href="#/signup">Sign up</a></div>');
  }
  function authSignup() {
    return authWrap('<div style="text-align:center"><div class="h2">Create your workspace</div><div class="small">Self-serve. Live in minutes, not weeks.</div></div>' +
      ['Name', 'Email', 'Password', 'Workspace name'].map(function (f, i) { return '<div class="field"><label>' + f + '</label><input class="input" type="' + ['text', 'email', 'password', 'text'][i] + '" /></div>'; }).join('') +
      '<button class="btn btn-primary btn-full" data-go="onboarding/1">Create account</button><div class="small" style="text-align:center">Already have an account? <a href="#/login">Log in</a></div>');
  }
  function authForgot() {
    return authWrap('<div class="h2" style="text-align:center">Reset your password</div><div class="field"><label>Email</label><input class="input" id="fpEmail" type="email" placeholder="you@company.com" /><span class="errmsg hidden" id="fpErr">Enter a valid email address.</span></div><button class="btn btn-primary btn-full" data-act="forgot">Send reset link</button><a href="#/login" class="small" style="text-align:center">← Back to login</a>');
  }
  function authReset() {
    return authWrap('<div class="h2" style="text-align:center">Choose a new password</div><div class="field"><label>New password</label><input class="input" type="password" /></div><div class="field"><label>Confirm password</label><input class="input" type="password" /></div><button class="btn btn-primary btn-full" data-go="login">Update password</button>');
  }
  function onboarding(step) {
    var dots = '<div class="steps">' + [1, 2, 3].map(function (i) { return '<i class="' + (i <= step ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var inner = step === 1 ? '<div class="h2" style="text-align:center">Welcome to Camplo</div><div class="small" style="text-align:center">Tell us about your workspace</div><div class="field"><label>Workspace name</label><input class="input" value="Northbeam Growth" /></div><div class="field"><label>Team size</label><select class="select"><option>Just me</option><option selected>3–10</option><option>11–20</option><option>20+</option></select></div>'
      : step === 2 ? '<div class="h2" style="text-align:center">Connect your first tool</div><div class="small" style="text-align:center">Camplo starts where the lead is born. Point a form or CRM at your inbound webhook.</div>' + ['Tally', 'GoHighLevel', 'Systeme.io', 'Twenty CRM'].map(function (t) { return '<div class="setting-row"><b>' + t + '</b><button class="btn btn-ghost btn-sm" data-act="toast" data-msg="' + t + ' connected">Connect</button></div>'; }).join('')
      : '<div class="h2" style="text-align:center">Upload your first page or invite your team</div><div class="small" style="text-align:center">Either one starts the watchtower.</div><button class="btn btn-ghost btn-full" data-act="upload">' + ic('upload', 15) + ' Upload a page (ZIP)</button><button class="btn btn-ghost btn-full" data-act="invite">Invite your team</button>';
    return authWrap(dots + inner + '<button class="btn btn-primary btn-full" data-go="' + (step < 3 ? 'onboarding/' + (step + 1) : 'dashboard') + '">' + (step < 3 ? 'Continue' : 'Open Camplo') + '</button><a href="#/' + (step < 3 ? 'onboarding/' + (step + 1) : 'dashboard') + '" class="small" style="text-align:center">Skip for now</a>');
  }

  // ---------- Client read-only (IN3) ----------
  function clientView(id) {
    var c = camp(id) || D.campaigns[0];
    var leads = D.leads.filter(function (l) { return l.campaign === c.id; });
    var r = leads.filter(function (l) { return l.respondedAt; }).length;
    return '<div class="client"><div class="spread"><div class="logo">C<span>.</span></div><span class="chip">Read-only client view</span></div>' +
      '<div class="spread wrap" style="margin-top:40px"><h1 class="h1">' + esc(c.name) + '</h1>' + healthBadge(c.health) + '</div><div class="small" style="margin-top:6px">Live campaign performance · updated in real time</div>' +
      '<div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-top:28px"><div class="kpi"><div class="label">Leads this period</div><div class="display">' + c.leads + '</div></div><div class="kpi"><div class="label">Responded</div><div class="display green">' + Math.round(c.leads * 0.955) + '</div></div><div class="kpi"><div class="label">Not responded</div><div class="display red">' + (c.leads - Math.round(c.leads * 0.955)) + '</div></div><div class="kpi"><div class="label">Speed-to-lead</div><div class="display ' + speedClass(c.avgResp) + '" style="font-size:36px">' + secs(c.avgResp) + '</div></div></div>' +
      '<div class="h3" style="margin:12px 0">Recent observations</div><div class="feed">' + sortInsights(D.insights.filter(function (i) { return i.camp === c.id; })).slice(0, 5).map(function (i, idx) { var x = Object.assign({}, i, { ev: i.ev.replace(/(Tunde|Sarah|Kofi|Amara|Marcus)[^.,]*/g, 'the team') }); return insightCard(x, idx).replace(/<button class="expand"[\s\S]*?<\/button>/, ''); }).join('') + '</div>' +
      '<div class="ts" style="text-align:center;margin-top:48px">Powered by Camplo</div></div>';
  }

  // ---------- Mobile feed (Screen 15) ----------
  function mobileFeed() {
    return '<div class="page" style="max-width:640px"><div class="spread"><div class="h2">Feed</div><span class="badge b-red b-bold">' + overdueLeads().length + ' overdue</span></div><div class="feed">' + sortInsights(D.insights).map(insightCard).join('') + '</div></div>';
  }

  // ---------- Overlays ----------
  function closeOverlay(silent) { overlay.innerHTML = ''; S.chatOpen = false; document.removeEventListener('keydown', escClose); }
  function escClose(e) { if (e.key === 'Escape') closeOverlay(); }
  function openOverlay(html) { overlay.innerHTML = '<div class="scrim" data-act="close"></div>' + html; document.addEventListener('keydown', escClose); tick(); tickSlow(); }
  function modal(title, body, foot) { return '<div class="modal" role="dialog"><div class="modal-head"><div class="h2">' + title + '</div><button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div>' + body + (foot ? '<div class="modal-foot">' + foot + '</div>' : '') + '</div>'; }
  function drawer(cls, head, body) { return '<aside class="drawer ' + cls + '"><div class="drawer-head">' + head + '<button class="close" data-act="close" aria-label="Close">' + ic('x', 18) + '</button></div><div class="drawer-body">' + body + '</div></aside>'; }
  function popover(html, anchor, width) {
    var r = anchor.getBoundingClientRect();
    var left = Math.min(window.innerWidth - width - 12, Math.max(12, r.right - width));
    overlay.innerHTML = '<div class="scrim" style="background:transparent;backdrop-filter:none" data-act="close"></div><div class="popover" style="top:' + (r.bottom + 8) + 'px;left:' + left + 'px;width:' + width + 'px">' + html + '</div>';
    document.addEventListener('keydown', escClose); tickSlow();
  }

  function lifecycleDrawer(id) {
    var l = byId(D.leads, id);
    return drawer('', '<div><div class="h3">Lifecycle — ' + esc(l.name) + '</div><a class="chip chip-blue" style="margin-top:8px" href="#/campaigns/' + l.campaign + '/overview">' + esc(camp(l.campaign).name) + '</a></div>',
      (l.external ? timeline(l) : empty('link', 'No external events yet.', 'Connect a CRM via webhook to see the full lead journey.', '<a class="btn btn-ghost" href="#/settings/integrations">Connect</a>')) +
      '<div class="row gap16" style="margin-top:24px"><span class="row ts"><span class="dot b"></span>Camplo</span><span class="row ts"><span class="dot" style="background:#A855F7"></span>External</span><span class="row ts"><span class="dot o"></span>Milestone</span></div>' +
      '<a class="btn btn-ghost" style="margin-top:24px" href="#/campaigns/' + l.campaign + '/leads/' + l.id + '">Open Lead Dossier</a>');
  }

  function chatPanel() {
    var msgs = S.chat.map(function (m) {
      if (m.sep) return '<div class="date-sep">' + m.sep + '</div>';
      if (m.u) return '<div class="msg-u">' + esc(m.u) + '</div>';
      if (m.thinking) return '<div class="investigating"><div class="brain-ico think" style="width:24px;height:24px">' + ic('brain', 13) + '</div>Investigating your campaigns…</div>';
      return '<div class="msg-a">' + ic('brain', 18) + '<div>' + m.a + '</div></div>';
    }).join('');
    var fresh = S.chat.filter(function (m) { return m.u; }).length <= 1;
    var depths = [['Economy', 'fast, lower cost'], ['Standard', 'balanced'], ['Deep', 'stronger reasoning'], ['Frontier', 'highest intelligence']];
    return '<aside class="drawer w400" id="chatPanel"><div class="drawer-head"><div class="row gap12"><div class="brain-ico">' + ic('brain', 18) + '</div><div><div class="h3">Camplo Intelligence</div><div class="ts italic">Aware of everything in your workspace</div></div></div><button class="close" data-act="close">' + ic('x', 18) + '</button></div>' +
      '<div class="chat" id="chatScroll">' + msgs +
      (fresh ? '<div class="col gap12" style="margin-top:8px">' + ['What needs my attention right now?', 'Which lead is most overdue?', 'What should I change about my campaigns this week?'].map(function (p) { return '<button class="prompt-chip" data-act="ask" data-q="' + p + '">' + p + '</button>'; }).join('') + '</div>' : '') + '</div>' +
      '<div class="chat-input"><button class="linkbtn" style="align-self:flex-start;font-size:12px;color:var(--text-muted)" data-act="depth">' + (S.depthOpen ? '▾' : '▸') + ' Choose depth · ' + S.depth + '</button>' +
      (S.depthOpen ? '<div class="radio-group">' + depths.map(function (d) { return '<span class="radio ' + (S.depth === d[0] ? 'on' : '') + '" data-act="setDepth" data-v="' + d[0] + '" title="' + d[1] + '"><i></i>' + d[0] + '</span>'; }).join('') + '</div>' + (S.depth === 'Deep' || S.depth === 'Frontier' ? '<div class="ts italic">Uses more AI capacity</div>' : '') : '') +
      '<div class="chat-box"><textarea class="input" id="chatInput" placeholder="Ask Camplo anything..." rows="2"></textarea><button class="send" id="chatSend" data-act="send" disabled aria-label="Send">' + ic('send', 16) + '</button></div></div></aside>';
  }
  function openChat() {
    S.chatOpen = true;
    overlay.innerHTML = '<div class="scrim" data-act="close" style="background:rgba(5,5,8,0.3)"></div>' + chatPanel();
    document.addEventListener('keydown', escClose);
    var sc = document.getElementById('chatScroll'); sc.scrollTop = sc.scrollHeight;
    var inp = document.getElementById('chatInput'); if (inp && window.innerWidth > 900) inp.focus();
  }
  function answer(q) {
    var lq = q.toLowerCase(), od = overdueLeads();
    if (/overdue|most urgent|waiting/.test(lq) && od.length) {
      var l = od[0];
      return 'The most overdue lead is <a href="#/campaigns/' + l.campaign + '/leads/' + l.id + '">' + esc(l.name) + '</a> on <b>' + esc(camp(l.campaign).name) + '</b> — waiting <span class="metric red">' + dur(Date.now() - l.arrived) + '</span> against a ' + D.slaMinutes + 'm threshold. ' + (l.assignee ? 'It is assigned to ' + esc(user(l.assignee).name) + '.' : 'Nobody has claimed it yet.') +
        '<table><tr><th>Lead</th><th>Waiting</th><th>Owner</th></tr>' + od.map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td class="red">' + dur(Date.now() - x.arrived) + '</td><td>' + (x.assignee ? first(x.assignee) : '—') + '</td></tr>'; }).join('') + '</table>Respond from the Dossier, or I can notify the assignee now.';
    }
    if (/change|this week|recommend|budget/.test(lq)) {
      return 'Three changes, in order of impact:<ol><li><b>Fix <a href="#/pages">bf-bundle-b</a> before spending more.</b> Its webhook has been silent for ' + dur(Date.now() - D.pages[1].ping) + ' while Meta spends ₦184,000/day.</li><li><b>Test the old Lekki positioning.</b> Qualified-lead rate fell 37% after the Aug 12 copy change; traffic and page conversion are unchanged.</li><li><b>Staff Tuesday 7–9pm.</b> 38% of webinar registrations land then with one person online.</li></ol>Note: creative changes previously hurt qualified-lead rate on Black Friday (Sep 3 test), so I am not recommending a creative refresh.';
    }
    if (/cpl|cost/.test(lq)) return 'Black Friday CPL is <span class="metric amber">₦14,860</span>, 24% over your ₦12,000 threshold. Lekki is <span class="metric">₦20,340</span> (inside its ₦25,000 threshold). Webinar has no tracked budget.';
    return 'Right now: <span class="metric red">' + od.length + ' overdue</span> leads, one <b>Priority Flag</b> on <a href="#/campaigns/bf26/insights">Black Friday 2026</a> (unclaimed leads + CRM lag + a silent webhook at the same time), and CPL over threshold for 5 days. Start with the overdue leads — <a href="#/campaigns/' + (od[0] || D.leads[0]).campaign + '/leads/' + (od[0] || D.leads[0]).id + '">' + esc((od[0] || D.leads[0]).name) + '</a> has waited longest. Everything else on Lekki and Webinar is healthy.';
  }
  function ask(q) {
    if (!q.trim()) return;
    S.chat.push({ u: q }); S.chat.push({ thinking: true });
    openChat();
    setTimeout(function () {
      S.chat.pop(); S.chat.push({ a: answer(q) });
      if (S.chatOpen) openChat();
    }, 1400);
  }

  function newCampaignModal() {
    return modal('New campaign', '<div class="col gap16">' +
      '<div class="field"><label>Campaign name</label><input class="input" id="ncName" placeholder="e.g. Christmas Hampers 2026" /><span class="errmsg hidden" id="ncErr">Give the campaign a name.</span></div>' +
      '<div class="field"><label>Description</label><textarea class="input" id="ncDesc" placeholder="What is this campaign, and what does success look like?"></textarea></div>' +
      '<div class="form-grid"><div class="field"><label>Owner</label><input class="input" value="' + esc(user(D.me).name) + '" disabled /></div><div class="field"><label>Start date</label><input class="input" type="date" id="ncDate" value="' + new Date().toISOString().slice(0, 10) + '" /></div></div>' +
      '<div class="form-grid"><div class="field"><label>Budget (optional)</label><div class="row"><select class="select" style="width:90px"><option>₦ NGN</option><option>$ USD</option><option>£ GBP</option></select><input class="input" id="ncBudget" placeholder="0" /></div></div><div class="field"><label>CPL threshold (optional)</label><input class="input" placeholder="Alert me when CPL exceeds this" /></div></div></div>',
      '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="createCampaign">Create Campaign</button>');
  }
  function uploadModal(step) {
    var steps = '<div class="steps">' + [1, 2, 3, 4].map(function (i) { return '<i class="' + (i <= step ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    var body = step === 1 ? '<div class="dropzone" data-act="uploadStep" data-v="2">' + ic('upload', 32) + '<div class="h3" style="margin-top:12px">Drop your page ZIP here</div><div class="small">or click to browse · index.html at the root · max 50 MB</div></div>'
      : step === 2 ? '<div class="small" style="margin-bottom:8px">Uploading christmas-hampers.zip · 2.4 MB</div><div class="progress"><i id="upProg"></i></div>'
        : step === 3 ? '<div class="col gap16"><div class="field"><label>Page name</label><input class="input" value="Christmas Hampers" /></div><div class="field"><label>Campaign</label><select class="select">' + D.campaigns.map(function (c) { return '<option>' + esc(c.name) + '</option>'; }).join('') + '</select></div><div class="field"><label>Slug</label><div class="row"><span class="mono">camplo.page/</span><input class="input mono" value="christmas-hampers" /></div></div></div>'
          : '<div class="empty" style="padding:24px"><div class="check-big">' + ic('check', 28) + '</div><div class="h">Page deployed</div><p class="mono">https://camplo.page/christmas-hampers</p><p class="small">Webhook is live. Camplo will watch the first 72 hours closely.</p></div>';
    var foot = step === 3 ? '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="uploadStep" data-v="4">Deploy</button>' : step === 4 ? '<button class="btn btn-ghost" data-act="close">View Page</button><button class="btn btn-primary" data-act="closeGo" data-v="campaigns/bf26/pages">Go to Campaign</button>' : '';
    return modal('Upload a new page', steps + body, foot);
  }
  function upgradeModal(plan) {
    var price = { Growth: 197, Watchtower: 347, Agency: 597 }[plan] || 347;
    return modal('Upgrade to ' + plan, '<div class="row gap12"><span class="chip">Current: ' + D.plan + '</span>' + ic('chev', 14) + '<span class="chip chip-blue">' + plan + '</span></div><ul class="small" style="line-height:1.9;margin:20px 0 0;padding-left:18px"><li>White-label retrospectives with your logo only</li><li>Client sub-accounts with read-only dashboards</li><li>Everything in ' + D.plan + ', unlimited</li></ul>',
      '<button class="linkbtn" data-act="close" style="margin-right:auto;color:var(--text-muted)">Maybe later</button><button class="btn btn-primary" data-act="close">Upgrade to ' + plan + ' — $' + price + '/month</button>');
  }
  function memberDrawer(id) {
    var u = user(id), camps = D.campaigns.filter(function (c) { return c.members.indexOf(id) >= 0; });
    return drawer('', '<div class="row gap12">' + av(id, 64) + '<div><div class="h2">' + esc(u.name) + '</div><div class="small">' + esc(u.email) + '</div><span class="badge nodot b-blue" style="margin-top:6px">' + u.role + '</span></div></div>',
      '<div class="label">Response performance</div><dl class="kv" style="grid-template-columns:1fr auto"><dt>Avg response this week</dt><dd class="' + (u.week <= u.avg30 ? 'green' : 'red') + '"><b>' + secs(u.week) + '</b></dd><dt>30-day average</dt><dd>' + secs(u.avg30) + '</dd><dt>Acknowledgment rate</dt><dd>' + u.ackRate + '%</dd><dt>SLA breaches this week</dt><dd class="' + (u.breaches ? 'red' : 'green') + '">' + u.breaches + '</dd></dl>' +
      '<div class="label" style="margin-top:24px">Campaigns</div>' + camps.map(function (c) { return '<div class="list-row"><span class="grow">' + esc(c.name) + '</span>' + healthBadge(c.health) + '</div>'; }).join('') +
      '<div class="label" style="margin-top:24px">Recent activity</div>' + D.leads.filter(function (l) { return l.assignee === id && l.respondedAt; }).slice(0, 6).map(function (l) { return '<div class="log"><span class="mono">' + clock(l.respondedAt) + '</span><span>Responded to <b>' + esc(l.name) + '</b></span></div>'; }).join('') +
      (u.role !== 'OWNER' ? '<div class="row" style="margin-top:24px"><button class="btn btn-ghost" data-act="toast" data-msg="Role updated">Edit Role</button><button class="btn btn-danger" data-act="removeMember" data-id="' + id + '">Remove Member</button></div>' : ''));
  }

  // ---------- toast ----------
  function toast(msg, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.innerHTML = '<span class="' + (type === 'error' ? 'red' : type === 'info' ? 'blue' : 'green') + '">' + ic(type === 'error' ? 'x' : 'check', 15) + '</span>' + esc(msg);
    document.getElementById('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 220); }, 3000);
  }

  // ---------- live timers ----------
  function tick() {
    var now = Date.now();
    var els = document.querySelectorAll('[data-since]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], since = +el.getAttribute('data-since'), stop = +el.getAttribute('data-stop') || 0;
      var ms = (stop || now) - since;
      el.textContent = dur(ms, true);
      var thr = +el.getAttribute('data-thr');
      if (thr) {
        var s = ms / 1000;
        el.classList.remove('green', 'amber', 'red', 'breach');
        el.classList.add(s < thr * 0.6 ? 'green' : s < thr ? 'amber' : 'red');
        if (s >= thr && !stop) el.classList.add('breach');
      }
    }
    var us = document.querySelectorAll('[data-until]');
    for (var j = 0; j < us.length; j++) {
      var left = +us[j].getAttribute('data-until') - now;
      us[j].textContent = left > 0 ? (us[j].getAttribute('data-prefix') || '') + dur(left).replace(/ \d+s$/, '') : '';
    }
  }
  function tickSlow() {
    var els = document.querySelectorAll('[data-ago]');
    for (var i = 0; i < els.length; i++) els[i].textContent = ago(+els[i].getAttribute('data-ago'));
  }
  setInterval(tick, 1000);
  setInterval(tickSlow, 30000);

  // ---------- search ----------
  function searchResults(q) {
    q = q.toLowerCase().trim();
    var box = document.getElementById('searchBox');
    if (!q) { if (box) box.remove(); return; }
    var cs = D.campaigns.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0; }).map(function (c) { return ['CAMPAIGNS', c.name, c.cid, 'campaigns/' + c.id + '/overview', 'target']; });
    var ls = D.leads.filter(function (l) { return (l.name + l.id).toLowerCase().indexOf(q) >= 0; }).map(function (l) { return ['LEADS', l.name, l.id + ' · ' + camp(l.campaign).name, 'campaigns/' + l.campaign + '/leads/' + l.id, 'inbox']; });
    var ps = D.pages.filter(function (p) { return p.name.indexOf(q) >= 0; }).map(function (p) { return ['PAGES', p.name, camp(p.camp).name, 'pages', 'file']; });
    var all = cs.concat(ls).concat(ps).slice(0, 12), html = '', last = '';
    all.forEach(function (r, i) { if (r[0] !== last) { html += '<div class="label">' + r[0] + '</div>'; last = r[0]; } html += '<div class="sr-item' + (i === 0 ? ' sel' : '') + '" data-go="' + r[3] + '">' + ic(r[4], 15) + '<div><div style="font-size:13px">' + esc(r[1]) + '</div><div class="ts">' + esc(r[2]) + '</div></div></div>'; });
    if (!all.length) html = '<div class="empty" style="padding:24px"><p class="muted">Nothing found for ‘' + esc(q) + '’</p></div>';
    if (!box) { box = document.createElement('div'); box.id = 'searchBox'; box.className = 'search-results'; document.getElementById('search').appendChild(box); }
    box.innerHTML = html;
  }

  // ---------- events ----------
  document.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'searchInput') searchResults(t.value);
    if (t.id === 'noteInput') document.getElementById('postNote').disabled = !t.value.trim();
    if (t.id === 'chatInput') document.getElementById('chatSend').disabled = !t.value.trim();
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
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!items.length) return; items[idx] && items[idx].classList.remove('sel'); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[idx].classList.add('sel'); }
      if (e.key === 'Enter' && items[idx]) { go(items[idx].getAttribute('data-go')); e.target.blur(); }
      if (e.key === 'Escape') e.target.blur();
    }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-filter')) {
      S.leadFilter[t.getAttribute('data-filter')] = t.value;
      var box = document.getElementById('leadTable'); var c = box.getAttribute('data-camp');
      box.innerHTML = leadTable(filteredLeads(c || undefined), !!c); tick(); tickSlow();
    }
    if (t.getAttribute('data-act-change') === 'reassign' && t.value) {
      var l = byId(D.leads, t.getAttribute('data-id'));
      if (l.assignee && l.assignee !== t.value) l.reassigned = { from: l.assignee, t: Date.now() };
      l.assignee = t.value; l.assignedAt = Date.now();
      toast('Reassigned to ' + user(t.value).name + ' — they have been notified'); render();
    }
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act],[data-go],[data-cmd],a[data-link]');
    if (!el) return;
    if (el.hasAttribute('data-cmd')) { e.preventDefault(); document.execCommand(el.getAttribute('data-cmd'), false, el.getAttribute('data-cmd') === 'hiliteColor' ? '#1A2560' : el.getAttribute('data-cmd') === 'createLink' ? 'https://' : null); return; }
    if (el.matches('a[data-link]')) { closeOverlay(); return; }
    var act = el.getAttribute('data-act');
    if (!act && el.hasAttribute('data-go')) { e.preventDefault(); closeOverlay(); go(el.getAttribute('data-go')); return; }
    if (el.tagName === 'A' && el.getAttribute('href') === '#') e.preventDefault();
    var id = el.getAttribute('data-id'), v = el.getAttribute('data-v');
    // Stop row navigation when an inner control is used.
    if (act && el.closest('tr[data-go]') && act !== 'pageDrawer') e.stopPropagation();
    switch (act) {
      case 'close': closeOverlay(); break;
      case 'closeGo': closeOverlay(); go(v); break;
      case 'theme':
        var light = document.documentElement.getAttribute('data-theme') !== 'light';
        document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark'); store('camplo-theme', light ? 'light' : 'dark');
        var dk = document.querySelector('.dock'); if (dk) dk.outerHTML = dock(); break;
      case 'chat': openChat(); break;
      case 'ask': ask(el.getAttribute('data-q')); break;
      case 'send': ask(document.getElementById('chatInput').value); break;
      case 'depth': S.depthOpen = !S.depthOpen; openChat(); break;
      case 'setDepth': S.depth = v; openChat(); break;
      case 'dismissBrief': S.briefDismissed = true; store('camplo-brief', new Date().toDateString()); render(); break;
      case 'insight':
        var ins = byId(D.insights, id);
        openOverlay(modal(ins.priority ? '<span class="red">Priority Flag</span>' : 'Insight', '<div class="obs" style="font:600 18px/1.4 var(--f-display)">' + esc(ins.obs) + '</div><p class="small" style="font-size:14px;line-height:1.7">' + esc(ins.ev) + '</p><div class="label" style="margin-top:20px">Sources reasoned over</div><div class="row wrap" style="margin-top:8px">' + ['Camplo leads', 'Umami', 'Twenty CRM', 'Meta Ads'].map(function (s) { return '<span class="chip">' + s + '</span>'; }).join('') + '</div><div class="ts" style="margin-top:16px">' + ago(ins.t) + ' · ' + esc(camp(ins.camp).name) + '</div>', '<button class="btn btn-ghost" data-act="close">Close</button><button class="btn btn-primary" data-act="closeGo" data-v="campaigns/' + ins.camp + '/insights">Open campaign insights</button>'));
        break;
      case 'collapse': el.classList.toggle('open'); el.nextElementSibling.classList.toggle('open'); break;
      case 'memory':
        openOverlay(modal('Campaign memory — Black Friday', '<ul class="timeline" style="margin-top:0">' + D.memory.map(function (m) { return '<li style="grid-template-columns:56px 30px 1fr auto"><span class="t">' + m.d + '</span><span class="tdot c"></span><span>' + m.txt + '</span><span class="badge nodot ' + (m.s === 'Applied' ? 'b-green' : 'b-grey') + '">' + m.s + '</span></li>'; }).join('') + '</ul><p class="small" style="margin-top:16px">Creative changes have previously improved CTR but degraded qualified-lead rate on this campaign. Camplo will not recommend another creative refresh without new evidence.</p>'));
        break;
      case 'dismissRec':
        var card = document.getElementById('rec-' + id); var rec = byId(D.recs, id);
        rec.dismissed = true; card.style.transition = 'all 250ms'; card.style.opacity = 0; card.style.transform = 'translateX(24px)';
        setTimeout(function () { card.remove(); }, 250);
        var el2 = document.createElement('div'); el2.className = 'toast info'; el2.innerHTML = 'Recommendation dismissed <button class="linkbtn" style="margin-left:auto">Undo</button>';
        el2.querySelector('button').onclick = function () { rec.dismissed = false; el2.remove(); render(); };
        document.getElementById('toasts').appendChild(el2); setTimeout(function () { el2.remove(); }, 4000);
        break;
      case 'respond':
        var l = byId(D.leads, id);
        el.classList.add('loading'); el.innerHTML = '<span class="spinner"></span> Responding...';
        setTimeout(function () {
          el.classList.remove('loading'); el.classList.add('success'); el.innerHTML = ic('check', 14) + ' Responded';
          l.respondedAt = Date.now(); if (!l.assignee) l.assignee = D.me;
          setTimeout(render, 1500);
        }, 700);
        break;
      case 'lifecycle': openOverlay(lifecycleDrawer(id)); break;
      case 'clearFilters': S.leadFilter = { status: 'all', campaign: 'all', assignee: 'all', sort: 'newest' }; render(); break;
      case 'newCampaign': openOverlay(newCampaignModal()); break;
      case 'createCampaign':
        var nm = document.getElementById('ncName');
        if (!nm.value.trim()) { nm.classList.add('err'); document.getElementById('ncErr').classList.remove('hidden'); nm.focus(); break; }
        var nid = 'c' + Date.now().toString(36);
        D.campaigns.unshift({ id: nid, cid: 'camp_' + nid, name: nm.value.trim(), health: 'HEALTHY', status: 'ACTIVE', pinned: false, desc: document.getElementById('ncDesc').value || 'New campaign.', avgResp: 0, budget: +document.getElementById('ncBudget').value || 0, daily: 0, cplThreshold: 0, leads: 0, start: document.getElementById('ncDate').value, owner: D.me, members: [D.me], pages: 0, notes: 0 });
        closeOverlay(); toast('Campaign created'); go('campaigns/' + nid + '/overview'); break;
      case 'markComplete':
        openOverlay(modal('Mark campaign complete?', '<p class="small" style="font-size:14px">This will generate a Campaign Retrospective automatically. This cannot be undone.</p>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="confirmComplete" data-id="' + id + '">Confirm</button>'));
        break;
      case 'confirmComplete': var cc = camp(id); cc.status = 'COMPLETE'; cc.end = new Date().toISOString().slice(0, 10); closeOverlay(); toast('Retrospective generated'); go('campaigns/' + id + '/retrospective'); break;
      case 'editOverview': S.editingOverview = true; render(); break;
      case 'cancelOverview': S.editingOverview = false; render(); break;
      case 'saveOverview': camp(id).brief = document.getElementById('ovEditor').innerHTML; S.editingOverview = false; toast('Brief saved'); render(); break;
      case 'ifilter': S.insightFilter = v; render(); break;
      case 'postNote':
        var inp = document.getElementById('noteInput'); if (!inp.value.trim()) break;
        D.notes.unshift({ id: 'n' + Date.now(), camp: el.getAttribute('data-camp') || null, lead: el.getAttribute('data-lead') || null, author: D.me, t: Date.now(), body: inp.value.trim() });
        toast('Note posted'); render(); break;
      case 'editNote': S.editNote = id; render(); break;
      case 'cancelNote': S.editNote = null; render(); break;
      case 'saveNote': var n = byId(D.notes, id); n.body = document.getElementById('editNoteInput').value; n.edited = Date.now(); S.editNote = null; toast('Note updated'); render(); break;
      case 'pageDrawer': openOverlay(pageDrawer(id)); break;
      case 'pageMenu':
        e.stopPropagation();
        var pg = byId(D.pages, id);
        popover(['Archive', 'Connect domain', 'Move to campaign'].map(function (x) { return '<div class="menu-item" data-act="toast" data-msg="' + x + ' — ' + pg.name + '">' + x + '</div>'; }).join('') + '<div class="menu-item" style="' + (pg.versions > 1 ? '' : 'opacity:0.4;pointer-events:none') + '" data-act="toast" data-msg="Rolled back">Rollback</div>', el, 200);
        break;
      case 'upload': openOverlay(uploadModal(1)); break;
      case 'uploadStep':
        openOverlay(uploadModal(+v));
        if (+v === 2) { var p = 0, bar = document.getElementById('upProg'); var t = setInterval(function () { p += 7; if (bar) bar.style.width = Math.min(100, p) + '%'; if (p >= 100) { clearInterval(t); openOverlay(uploadModal(3)); } }, 60); }
        break;
      case 'testHook': toast('Test event sent — waiting for response', 'info'); setTimeout(function () { toast('Webhook responded 200 OK in 184ms'); }, 1200); break;
      case 'slaTab': S.slaTab = v; render(); break;
      case 'slaDay': S.slaDay = v === '' ? null : +v; render(); break;
      case 'saveSla': D.slaMinutes = Math.max(1, +document.getElementById('slaMin').value || 30); toast('Threshold saved — ' + D.slaMinutes + ' minutes'); break;
      case 'notify':
        el.classList.add('loading'); el.innerHTML = '<span class="spinner"></span>';
        setTimeout(function () { el.classList.remove('loading'); el.classList.add('success'); el.innerHTML = ic('check', 13) + ' Notified'; toast('Telegram + email sent'); }, 700); break;
      case 'toggle': el.classList.toggle('on'); break;
      case 'ruleToggle':
        el.classList.toggle('on'); var row = el.parentNode; row.classList.toggle('off');
        row.querySelectorAll('input,select').forEach(function (x) { x.disabled = !el.classList.contains('on'); }); break;
      case 'saved':
        el.classList.add('success'); var prev = el.innerHTML; el.innerHTML = 'Saved ' + ic('check', 13);
        setTimeout(function () { el.classList.remove('success'); el.innerHTML = prev; }, 1500); break;
      case 'verify': el.innerHTML = '<span class="spinner"></span>'; setTimeout(function () { el.innerHTML = 'Verified ' + ic('check', 13); el.classList.add('success'); toast('Key verified'); }, 900); break;
      case 'eye': var f = document.getElementById(el.getAttribute('data-for')); f.type = f.type === 'password' ? 'text' : 'password'; break;
      case 'copy': toast('Copied to clipboard'); break;
      case 'toast': toast(el.getAttribute('data-msg')); break;
      case 'notifs':
        popover('<div class="spread" style="padding:8px 12px"><b>Notifications</b><button class="linkbtn" data-act="toast" data-msg="All marked as read">Mark all read</button></div>' +
          [['r', 'SLA breached — ' + (overdueLeads()[0] || D.leads[0]).name, 'campaigns/' + (overdueLeads()[0] || D.leads[0]).campaign + '/leads/' + (overdueLeads()[0] || D.leads[0]).id, 12 * MIN], ['r', 'bf-bundle-b webhook offline', 'pages', 58 * MIN], ['b', 'Priority Flag raised on Black Friday 2026', 'campaigns/bf26/insights', 18 * MIN], ['g', 'Tunde responded to a VIP lead in 3m 42s', 'campaigns/prop/insights', 4 * HOUR]].map(function (n) {
            return '<div class="notif" data-go="' + n[2] + '"><span class="dot ' + n[0] + '" style="margin-top:6px"></span><div><div style="font-size:13px">' + esc(n[1]) + '</div><div class="ts">' + ago(Date.now() - n[3]) + '</div></div></div>';
          }).join(''), el, 340); break;
      case 'usermenu':
        var me = user(D.me);
        popover('<div style="padding:10px 12px;border-bottom:1px solid var(--border-subtle);margin-bottom:4px"><b>' + esc(me.name) + '</b><div class="ts">' + esc(me.email) + '</div></div>' +
          '<div class="menu-item" data-go="me">My Performance</div><div class="menu-item" data-go="settings/team">Profile settings</div><div class="menu-item" data-act="upgrade" data-plan="Agency">Current plan: ' + D.plan + ' <span class="chip chip-plan" style="margin-left:auto">Upgrade</span></div><div class="menu-item" data-go="client/bf26">Client view (preview)</div><div class="menu-item" data-act="shortcuts">Keyboard shortcuts</div>' +
          '<div style="height:1px;background:var(--border-subtle);margin:4px 0"></div><div class="menu-item" style="color:var(--status-red)" data-go="login">Sign out</div>', el, 240); break;
      case 'shortcuts': openOverlay(modal('Keyboard shortcuts', '<dl class="kv" style="grid-template-columns:1fr auto"><dt>Search</dt><dd class="mono">⌘ K</dd><dt>Post note / send message</dt><dd class="mono">⌘ Enter</dd><dt>Close panel</dt><dd class="mono">Esc</dd></dl>')); break;
      case 'upgrade': openOverlay(upgradeModal(el.getAttribute('data-plan'))); break;
      case 'share':
        openOverlay(modal('Share read-only client view', '<p class="small">Clients see leads, response counts, speed-to-lead, health and high-level AI observations. No team names, notes, settings or other campaigns.</p><div class="input-wrap" style="margin-top:12px"><input class="input mono" readonly value="' + location.origin + '/#/client/' + id + '" style="font-size:12px" /><span class="acts"><button data-act="copy">' + ic('copy', 14) + '</button></span></div>', '<button class="btn btn-ghost" data-act="toast" data-msg="Link revoked">Revoke link</button><button class="btn btn-primary" data-act="closeGo" data-v="client/' + id + '">Open client view</button>'));
        break;
      case 'invite':
        openOverlay(modal('Invite team member', '<div class="col gap16"><div class="field"><label>Email</label><input class="input" id="invEmail" type="email" placeholder="teammate@company.com" /><span class="errmsg hidden" id="invErr">Enter a valid email address.</span></div><div class="field"><label>Role</label><select class="select"><option>Member</option><option>Admin</option></select></div><div class="ts">Invitation expires after 7 days.</div></div>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-primary" data-act="sendInvite">Send Invite</button>'));
        break;
      case 'sendInvite':
        var em = document.getElementById('invEmail');
        if (!/^\S+@\S+\.\S+$/.test(em.value)) { em.classList.add('err'); document.getElementById('invErr').classList.remove('hidden'); break; }
        openOverlay(modal('Invitation sent', '<div class="empty" style="padding:16px"><div class="check-big">' + ic('check', 28) + '</div><p>Invitation sent to <b>' + esc(em.value) + '</b></p></div>', '<button class="btn btn-ghost" data-act="invite">Invite another</button><button class="btn btn-primary" data-act="close">Done</button>'));
        break;
      case 'member': if (e.target.closest('.acts')) break; openOverlay(memberDrawer(id)); break;
      case 'editRole':
        e.stopPropagation();
        popover(['Admin', 'Member'].map(function (r) { return '<div class="menu-item" data-act="setRole" data-id="' + id + '" data-v="' + r.toUpperCase() + '">' + r + '</div>'; }).join(''), el, 160); break;
      case 'setRole': user(id).role = v; closeOverlay(); toast('Role changed to ' + v.toLowerCase()); render(); break;
      case 'removeMember':
        e.stopPropagation();
        openOverlay(modal('Remove ' + esc(user(id).name) + '?', '<p class="small" style="font-size:14px">They lose access immediately. Their notes and audit history stay — notes are permanent.</p>', '<button class="btn btn-ghost" data-act="close">Cancel</button><button class="btn btn-danger" data-act="confirmRemove" data-id="' + id + '">Remove member</button>'));
        break;
      case 'confirmRemove': D.team = D.team.filter(function (u) { return u.id !== id; }); closeOverlay(); toast('Member removed'); render(); break;
      case 'postTeamNote':
        var body = document.getElementById('tnBody');
        if (!body.value.trim()) { body.classList.add('err'); break; }
        var att = document.getElementById('tnAttach').value, due = +document.getElementById('tnDue').value;
        D.teamNotes.unshift({ id: 't' + Date.now(), author: D.me, to: [document.getElementById('tnTo').value], t: Date.now(), body: body.value.trim(), camp: att ? att.slice(2) : null, deadline: due ? Date.now() + due * HOUR : null, read: true });
        toast('Team note posted — they have been notified'); render(); break;
      case 'pdf': toast('Retrospective PDF is being prepared', 'info'); setTimeout(function () { window.print(); }, 400); break;
      case 'login':
        el.innerHTML = '<span class="spinner"></span>'; setTimeout(function () { go('dashboard'); }, 500); break;
      case 'forgot':
        var fe = document.getElementById('fpEmail');
        if (!/^\S+@\S+\.\S+$/.test(fe.value)) { fe.classList.add('err'); document.getElementById('fpErr').classList.remove('hidden'); break; }
        toast('Reset link sent to ' + fe.value); go('login'); break;
    }
  });

  render();
})();
