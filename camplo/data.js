/* Camplo demo workspace. Times are relative to page load so timers are live. */
(function () {
  var NOW = Date.now();
  var MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  var ago = function (ms) { return NOW - ms; };

  var team = [
    { id: 'u1', name: 'Marcus Adeyemi', email: 'marcus@northbeam.ng', role: 'OWNER', initials: 'MA', lastActive: ago(2 * MIN), week: 4 * 60 + 12, avg30: 5 * 60 + 40, ackRate: 98, breaches: 0 },
    { id: 'u2', name: 'Tunde Omolayo', email: 'tunde@northbeam.ng', role: 'ADMIN', initials: 'TO', lastActive: ago(6 * MIN), week: 3 * 60 + 42, avg30: 6 * 60 + 5, ackRate: 96, breaches: 1 },
    { id: 'u3', name: 'Sarah Okafor', email: 'sarah@northbeam.ng', role: 'MEMBER', initials: 'SO', lastActive: ago(24 * MIN), week: 11 * 60 + 20, avg30: 8 * 60 + 2, ackRate: 88, breaches: 4 },
    { id: 'u4', name: 'Amara Nwosu', email: 'amara@northbeam.ng', role: 'MEMBER', initials: 'AN', lastActive: ago(3 * HOUR), week: 2 * 60 + 58, avg30: 3 * 60 + 31, ackRate: 100, breaches: 0 },
    { id: 'u5', name: 'Kofi Mensah', email: 'kofi@northbeam.ng', role: 'MEMBER', initials: 'KM', lastActive: ago(1 * DAY), week: 7 * 60 + 9, avg30: 7 * 60 + 44, ackRate: 91, breaches: 2 }
  ];

  var campaigns = [
    { id: 'bf26', cid: 'camp_bf26_9x2k', name: 'Black Friday 2026', health: 'CRITICAL', status: 'ACTIVE', pinned: true,
      desc: 'Paid social push for the Black Friday bundle. Three landing pages on Meta traffic with Tally forms feeding Twenty CRM.',
      avgResp: 34 * 60 + 10, budget: 4500000, daily: 180000, cplThreshold: 12000, leads: 412, start: '2026-09-01', owner: 'u1', members: ['u1', 'u2', 'u3', 'u5'], pages: 3, notes: 14 },
    { id: 'prop', cid: 'camp_prop_4m1a', name: 'Lekki Property Enquiry — Q3', health: 'WATCH', status: 'ACTIVE', pinned: true,
      desc: 'Enquiry funnel for off-plan units. Leads route from GoHighLevel. High ticket — every lead is worth a call inside 5 minutes.',
      avgResp: 7 * 60 + 48, budget: 2400000, daily: 80000, cplThreshold: 25000, leads: 118, start: '2026-08-12', owner: 'u1', members: ['u1', 'u2', 'u4'], pages: 2, notes: 9 },
    { id: 'web', cid: 'camp_web_7q3p', name: 'Growth Webinar Series', health: 'HEALTHY', status: 'ACTIVE', pinned: true,
      desc: 'Weekly webinar registrations from Systeme.io. Nurture sequence in Brevo, sales follow-up for attendees only.',
      avgResp: 3 * 60 + 12, budget: 0, leads: 684, start: '2026-07-20', owner: 'u1', members: ['u1', 'u4', 'u5'], pages: 1, notes: 6 },
    { id: 'ref', cid: 'camp_ref_2c8d', name: 'Customer Referral Drive', health: 'HEALTHY', status: 'ACTIVE', pinned: false,
      desc: 'Referral page shared with existing customers. Low volume, high intent. Typeform capture.',
      avgResp: 4 * 60 + 5, budget: 600000, daily: 20000, cplThreshold: 15000, leads: 57, start: '2026-09-10', owner: 'u1', members: ['u1', 'u3'], pages: 1, notes: 2 },
    { id: 'sum', cid: 'camp_sum_1a0z', name: 'Summer Launch 2026', health: 'HEALTHY', status: 'COMPLETE', pinned: false,
      desc: 'Product launch across Meta and Google. Completed Aug 31. Retrospective generated automatically.',
      avgResp: 4 * 60 + 32, budget: 3200000, leads: 391, start: '2026-06-01', end: '2026-08-31', owner: 'u1', members: ['u1', 'u2', 'u3', 'u4', 'u5'], pages: 4, notes: 22 }
  ];

  var firstNames = ['Sarah Jenkins', 'Chidi Eze', 'Folake Ade', 'David Mensah', 'Ngozi Obi', 'Ibrahim Musa', 'Grace Lawal', 'Emeka Nnaji', 'Aisha Bello', 'Yemi Alade', 'Kwame Asante', 'Zainab Yusuf', 'Tolu Bakare', 'Joy Ekpo', 'Segun Arinze', 'Halima Sani', 'Uche Okoro', 'Bisi Coker', 'Femi Kuti', 'Ada Igwe'];
  var pagesByCamp = { bf26: ['bf-bundle-a', 'bf-bundle-b', 'bf-vip-early'], prop: ['lekki-offplan', 'lekki-brochure'], web: ['webinar-register'], ref: ['refer-a-friend'], sum: ['summer-main'] };
  var srcByCamp = { bf26: 'Tally', prop: 'GoHighLevel', web: 'Systeme.io', ref: 'Typeform', sum: 'Tally' };
  // [campaign, minutes since arrival, state, assignee, responseSeconds]
  var spec = [
    ['bf26', 3.4, 'unassigned'], ['prop', 8.2, 'assigned', 'u1'], ['bf26', 41, 'assigned', 'u3'], ['bf26', 194, 'unassigned'],
    ['web', 12, 'responded', 'u4', 142], ['prop', 67, 'assigned', 'u2'], ['bf26', 22, 'responded', 'u2', 222], ['ref', 95, 'responded', 'u3', 310],
    ['web', 140, 'responded', 'u5', 188], ['bf26', 180, 'responded', 'u3', 2710], ['bf26', 1.1, 'unassigned'], ['web', 300, 'responded', 'u4', 96],
    ['prop', 420, 'responded', 'u1', 204], ['bf26', 510, 'responded', 'u5', 1310], ['web', 600, 'responded', 'u4', 120], ['bf26', 55, 'assigned', 'u5'],
    ['ref', 800, 'responded', 'u3', 480], ['web', 1000, 'responded', 'u5', 260], ['bf26', 1400, 'responded', 'u2', 175], ['prop', 1600, 'responded', 'u2', 330]
  ];
  var leads = spec.map(function (s, i) {
    var name = firstNames[i];
    var slug = name.toLowerCase().split(' ')[0];
    var pages = pagesByCamp[s[0]];
    var arrived = ago(s[1] * MIN);
    return {
      id: 'CP' + (4821 - i), campaign: s[0], name: name,
      email: slug + '.' + name.split(' ')[1].toLowerCase() + '@gmail.com',
      phone: '+234 80' + (31 + i) + ' ' + (412 + i * 7) + ' ' + (1000 + i * 37),
      arrived: arrived, state: s[2], assignee: s[3] || null,
      assignedAt: s[2] === 'assigned' ? arrived + Math.min(4 * MIN, s[1] * MIN * 0.3) : null,
      respondedAt: s[4] ? arrived + s[4] * 1000 : null,
      page: pages[i % pages.length], source: srcByCamp[s[0]],
      sourceId: srcByCamp[s[0]].toLowerCase().replace(/[^a-z]/g, '') + '_sub_' + (98231 + i * 13).toString(36),
      utm: i % 4 === 3 ? null : { source: i % 2 ? 'facebook' : 'instagram', medium: 'paid_social', campaign: s[0] + '_2026', content: i % 3 ? 'carousel_v2' : 'video_15s', term: i % 5 === 0 ? 'bundle deal' : null },
      external: i % 3 !== 1,
      vip: s[0] === 'prop'
    };
  });

  var insights = [
    { id: 'i0', priority: true, type: 'red', camp: 'bf26', cat: 'SLA', t: ago(18 * MIN),
      obs: 'Black Friday is failing at three handoffs at once — this is systemic, not one slow rep.',
      ev: '2 leads unclaimed past threshold, 14 acknowledged leads missing from Twenty CRM, and bf-bundle-b’s webhook has been silent 2h 10m while Meta spent ₦184,000 today.' },
    { id: 'i1', type: 'red', camp: 'bf26', cat: 'SLA', t: ago(34 * MIN),
      obs: '14 leads acknowledged this week have not been logged in your CRM.',
      ev: 'The oldest is 3 days overdue. 9 were assigned to Tunde and 5 to Sarah. Your CRM threshold is 24 hours after acknowledgment.' },
    { id: 'i2', type: 'amber', camp: 'bf26', cat: 'Spend', t: ago(52 * MIN),
      obs: 'CPL on Black Friday has crossed your ₦12,000 threshold for the 5th day running.',
      ev: 'CPL is ₦14,860 (+28% vs 14-day baseline). Ad CTR is unchanged, so traffic quality is not the cause — conversion on bf-bundle-b fell from 9.1% to 4.2%.' },
    { id: 'i3', type: 'amber', camp: 'prop', cat: 'Engagement', t: ago(2 * HOUR),
      obs: 'Lekki leads open the first Brevo email but drop off at step 2.',
      ev: 'Step 1 open rate 61%, step 2 open rate 14%. The drop began when the step-2 subject line changed on Sep 18.' },
    { id: 'i4', type: 'blue', camp: 'web', cat: 'Performance', t: ago(3 * HOUR),
      obs: 'Webinar registrations peak on Tuesdays between 7 and 9pm.',
      ev: '38% of this month’s 684 registrations arrived in that window, yet only 1 team member is typically online then.' },
    { id: 'i5', type: 'green', camp: 'prop', cat: 'SLA', t: ago(4 * HOUR),
      obs: 'Tunde responded to a Lekki VIP lead in 3m 42s — inside the 5-minute conversion window.',
      ev: 'That lead has already moved to “Meeting booked” in GoHighLevel. Tunde’s best response time this month.' },
    { id: 'i6', type: 'green', camp: 'web', cat: 'Performance', t: ago(26 * HOUR),
      obs: 'webinar-register now converts at 2.1× your account average.',
      ev: '18.4% conversion vs 8.7% account average across 1,940 visits in the last 7 days (Umami).' },
    { id: 'i7', type: 'blue', camp: 'ref', cat: 'Performance', t: ago(28 * HOUR),
      obs: 'Referral leads close at 4× the rate of paid social leads.',
      ev: '9 of 57 referral leads reached “Won” in Twenty CRM vs 13 of 412 on Black Friday.' }
  ];

  var recs = [
    { id: 'r1', level: 2, camp: 'bf26', action: 'Reduce Black Friday budget on bf-bundle-b by 20% until its webhook is fixed',
      why: 'Qualified-lead efficiency on this page has declined 34% over 14 days while spend kept rising.',
      evidence: ['CPL: +28% vs baseline', 'Qualified-lead rate: −34%', 'Conversion to opportunity: −19%', 'bf-bundle-a qualified-lead efficiency: +41%'],
      diagnosis: 'The decline originates after lead acquisition, not traffic generation. Ad CTR is unchanged. The page’s webhook dropped submissions intermittently since Sep 22.',
      outcome: 'Lower lead volume but higher qualified-opportunity efficiency.', risk: 'bf-bundle-b may still feed top-of-funnel volume; cutting too far could thin the pipeline.',
      conf: 3, next: 'Reduce by 20%, reassess after 7 days or 100 leads.', whynow: 'CPL above baseline 5 consecutive days; alert threshold crossed twice.', memory: true },
    { id: 'r2', level: 3, camp: 'prop', action: 'Test the previous Lekki landing-page positioning against the new variant before changing media',
      why: 'Lead volume is stable but the qualified-lead rate dropped 37% after the Aug 12 messaging change.',
      evidence: ['Traffic quality: stable (CTR unchanged)', 'Landing page conversion: unchanged', 'Qualified-lead rate: −37%', 'Decline began after Aug 12 copy change'],
      diagnosis: 'Traffic → page → lead is healthy. The new “from ₦15m” positioning attracts browsers rather than buyers. Qualification is where it breaks.',
      outcome: 'Recover qualified-lead rate toward the July baseline of 31%.', risk: 'Old positioning produced ~12% fewer total enquiries.',
      conf: 4, next: 'Run a 50/50 split for 10 days.', whynow: 'Three weeks of consistent decline; sample now large enough (118 leads).' },
    { id: 'r3', level: 4, camp: null, action: 'Stop optimising for lead volume — reallocate toward referral and webinar channels',
      why: 'Your highest-volume channel is not your most efficient growth channel.',
      evidence: ['Paid social: 61% of leads · 28% of qualified opportunities', 'Referral + webinar: 19% of leads · 41% of qualified opportunities', '90-day window across 5 campaigns', 'Won-rate on referral leads is 4× paid social'],
      diagnosis: 'Across 90 days, cost per qualified opportunity on paid social is 3.2× referral. Volume masks the inefficiency in weekly reports.',
      outcome: 'Fewer total leads, materially more closed deals per naira.', risk: 'Referral volume has a ceiling; paid social still seeds awareness.',
      conf: 3, next: 'Shift 15% of paid social budget to referral incentives next month.', whynow: 'Q4 budgets are being set this week.' }
  ];

  var notes = [
    { id: 'n1', camp: 'bf26', author: 'u2', t: ago(40 * MIN), body: 'bf-bundle-b form looks broken on iOS Safari — submit button does nothing. Checking with the dev now.' },
    { id: 'n2', camp: 'bf26', author: 'u1', t: ago(5 * HOUR), body: 'Pausing the video ad set until CPL comes back under threshold. Carousel is carrying the campaign.', edited: ago(4.5 * HOUR) },
    { id: 'n3', camp: 'bf26', author: 'u3', t: ago(26 * HOUR), body: 'Called 11 leads from yesterday afternoon. 4 want the bundle delivered before Nov 20 — flagging for ops.' },
    { id: 'n4', camp: 'bf26', author: 'ext', via: 'Fireflies', t: ago(30 * HOUR), body: 'Meeting summary — Weekly campaign sync: agreed to test a VIP early-access page; Kofi owns the Tally form; revisit budget Friday.' }
  ];

  var teamNotes = [
    { id: 't1', author: 'u1', to: ['u3'], t: ago(35 * MIN), body: 'Please call Folake Ade before 3pm — she asked for pricing twice.', lead: 'CP4819', deadline: NOW + 50 * MIN, read: false },
    { id: 't2', author: 'u2', to: ['u1'], t: ago(2 * HOUR), body: 'Twenty CRM sync is dropping the phone field for Tally leads. Can we raise it with support?', camp: 'bf26', read: true },
    { id: 't3', author: 'u1', to: ['u2', 'u4'], t: ago(20 * HOUR), body: 'Great work on response times this week. Let’s keep the Lekki VIP leads under 5 minutes.', read: true },
    { id: 't4', author: 'u1', to: ['u5'], t: ago(26 * HOUR), body: 'Update the bf-vip-early form fields before Friday.', camp: 'bf26', deadline: ago(2 * HOUR), read: true, met: false }
  ];

  var pages = [
    { id: 'p1', name: 'bf-bundle-a', camp: 'bf26', status: 'ACTIVE', hook: 'healthy', ping: ago(3 * MIN), visits: 8420, leads: 214, versions: 3, age: 25 * DAY },
    { id: 'p2', name: 'bf-bundle-b', camp: 'bf26', status: 'ACTIVE', hook: 'offline', ping: ago(130 * MIN), visits: 5610, leads: 124, versions: 2, age: 25 * DAY },
    { id: 'p3', name: 'bf-vip-early', camp: 'bf26', status: 'ACTIVE', hook: 'warning', ping: ago(2.2 * HOUR), visits: 610, leads: 4, versions: 1, age: 31 * HOUR, watch72: true },
    { id: 'p4', name: 'lekki-offplan', camp: 'prop', status: 'ACTIVE', hook: 'healthy', ping: ago(11 * MIN), visits: 2980, leads: 86, versions: 4, age: 45 * DAY },
    { id: 'p5', name: 'lekki-brochure', camp: 'prop', status: 'PAUSED', hook: 'never', ping: null, visits: 940, leads: 32, versions: 1, age: 40 * DAY },
    { id: 'p6', name: 'webinar-register', camp: 'web', status: 'ACTIVE', hook: 'healthy', ping: ago(1 * MIN), visits: 3710, leads: 684, versions: 6, age: 68 * DAY },
    { id: 'p7', name: 'refer-a-friend', camp: 'ref', status: 'ACTIVE', hook: 'healthy', ping: ago(47 * MIN), visits: 420, leads: 57, versions: 1, age: 16 * DAY },
    { id: 'p8', name: 'summer-main', camp: 'sum', status: 'ARCHIVED', hook: 'never', ping: null, visits: 12100, leads: 391, versions: 5, age: 117 * DAY }
  ];

  var memory = [
    { d: 'Aug 15', txt: 'Changed audience targeting → qualified-lead rate +8%', s: 'Applied' },
    { d: 'Sep 3', txt: 'Changed creative → CTR +12% but qualified-lead rate −22%', s: 'Applied' },
    { d: 'Sep 18', txt: 'Reverted creative → qualified-lead rate recovered to baseline', s: 'Applied' },
    { d: 'Sep 21', txt: 'Camplo recommended creative change', s: 'Dismissed' }
  ];

  window.CAMPLO = { NOW: NOW, MIN: MIN, HOUR: HOUR, DAY: DAY, team: team, campaigns: campaigns, leads: leads, insights: insights, recs: recs, notes: notes, teamNotes: teamNotes, pages: pages, memory: memory, me: 'u1', slaMinutes: 30, plan: 'Watchtower' };
})();
