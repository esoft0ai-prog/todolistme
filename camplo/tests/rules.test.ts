import { describe, expect, it } from 'vitest';
import {
  ackRateSignal, assignmentPathFor, canRespond, cpl, customerWaitingMs, formatDuration, hasFeature, hasRollbackAvailable, hasSufficientEvidence,
  healthPulse, isOverdue, leadVolumeSignal, MIN, DAY, noteEditable, orderInsights, recommendationLevelAllowed, responseTimeMs, speedColor, timerColor,
  webhookSignal, webhookState, type TimerLead,
} from '../server/domain/rules.js';

const base = (o: Partial<TimerLead> = {}): TimerLead => ({
  receivedAt: new Date('2026-09-26T10:00:00Z'), respondedAt: null, assignmentPath: null, claimedAt: null, assignedAt: null, reassignedAt: null, status: 'not_responded', ...o,
});
const at = (hhmm: string) => new Date(`2026-09-26T${hhmm}:00Z`);

describe('SLA double timer', () => {
  it('Timer 1 counts from received_at and freezes at responded_at', () => {
    expect(customerWaitingMs(base(), at('10:44'))).toBe(44 * MIN);
    expect(customerWaitingMs(base({ respondedAt: at('10:05'), status: 'responded' }), at('12:00'))).toBe(5 * MIN);
  });
  it('Timer 2 anchors on claim (A), assignment (B) or reassignment (C)', () => {
    expect(responseTimeMs(base(), at('10:30'))).toBeNull();
    expect(responseTimeMs(base({ assignmentPath: 'B', assignedAt: at('10:45') }), at('10:47'))).toBe(2 * MIN);
    expect(responseTimeMs(base({ assignmentPath: 'C', assignedAt: at('10:05'), reassignedAt: at('10:40') }), at('10:50'))).toBe(10 * MIN);
    const done = base({ assignmentPath: 'A', claimedAt: at('10:44'), respondedAt: at('10:44'), status: 'responded' });
    expect(responseTimeMs(done, at('11:00'))).toBe(0);
  });
  it('reassignment never resets Timer 1', () => {
    const l = base({ assignmentPath: 'C', reassignedAt: at('11:00') });
    expect(customerWaitingMs(l, at('11:10'))).toBe(70 * MIN);
  });
  it('overdue only while not responded', () => {
    expect(isOverdue(base(), 30, at('10:31'))).toBe(true);
    expect(isOverdue(base(), 30, at('10:29'))).toBe(false);
    expect(isOverdue(base({ status: 'responded', respondedAt: at('10:20') }), 30, at('12:00'))).toBe(false);
  });
  it('timer colours at 75% / 100% of threshold', () => {
    expect(timerColor(20 * MIN, 30)).toBe('green');
    expect(timerColor(23 * MIN, 30)).toBe('amber');
    expect(timerColor(30 * MIN, 30)).toBe('red');
  });
  it('speed-to-lead colour and formatting', () => {
    expect(speedColor(4 * MIN)).toBe('green');
    expect(speedColor(10 * MIN)).toBe('amber');
    expect(speedColor(31 * MIN)).toBe('red');
    expect(formatDuration(272_000)).toBe('4m 32s');
    expect(formatDuration(3 * 3600_000 + 14 * MIN)).toBe('3h 14m');
  });
});

describe('lead ownership', () => {
  it('Respond: unassigned → anyone; assigned → only assignee or owner', () => {
    expect(canRespond({ status: 'not_responded', assigneeId: null }, 'u2', 'member')).toBe(true);
    expect(canRespond({ status: 'not_responded', assigneeId: 'u1' }, 'u2', 'member')).toBe(false);
    expect(canRespond({ status: 'not_responded', assigneeId: 'u1' }, 'u1', 'member')).toBe(true);
    expect(canRespond({ status: 'not_responded', assigneeId: 'u1' }, 'u9', 'owner')).toBe(true);
    expect(canRespond({ status: 'responded', assigneeId: null }, 'u9', 'owner')).toBe(false);
  });
  it('assigning an unowned lead is Path B, an owned lead Path C', () => {
    expect(assignmentPathFor(null)).toBe('B');
    expect(assignmentPathFor('u1')).toBe('C');
  });
});

describe('Health Pulse', () => {
  it('signals', () => {
    expect(leadVolumeSignal(90, 100)).toBe('green');
    expect(leadVolumeSignal(60, 100)).toBe('amber');
    expect(leadVolumeSignal(40, 100)).toBe('red');
    expect(leadVolumeSignal(0, 10)).toBe('red');
    expect(ackRateSignal(95, 100)).toBe('green');
    expect(ackRateSignal(75, 100)).toBe('amber');
    expect(ackRateSignal(50, 100)).toBe('red');
    expect(webhookSignal(['operational', 'stale'])).toBe('amber');
    expect(webhookSignal(['offline'])).toBe('red');
  });
  it('combines into healthy / watch / critical', () => {
    expect(healthPulse(['green', 'green', 'green'])).toBe('healthy');
    expect(healthPulse(['green', 'amber', 'green'])).toBe('watch');
    expect(healthPulse(['amber', 'amber', 'green'])).toBe('critical');
    expect(healthPulse(['green', 'red', 'green'])).toBe('critical');
  });
});

describe('webhook health', () => {
  const now = at('12:00');
  it('never connected / operational / stale / offline', () => {
    expect(webhookState(null, 480, now)).toBe('never_connected');
    expect(webhookState(at('11:30'), 480, now)).toBe('operational');
    expect(webhookState(at('10:45'), 480, now)).toBe('stale');
    expect(webhookState(at('09:59'), 480, now)).toBe('offline');
    expect(webhookState(at('11:40'), 15, now)).toBe('stale');
  });
});

describe('notes, money, deployments, plans', () => {
  it('notes editable by author for 2 hours only', () => {
    expect(noteEditable(at('10:00'), 'a', 'a', at('11:59'))).toBe(true);
    expect(noteEditable(at('10:00'), 'a', 'a', at('12:00'))).toBe(false);
    expect(noteEditable(at('10:00'), 'a', 'b', at('10:01'))).toBe(false);
  });
  it('CPL', () => {
    expect(cpl(1000, 8)).toBe(125);
    expect(cpl(null, 8)).toBeNull();
    expect(cpl(1000, 0)).toBeNull();
  });
  it('rollback window is 30 days', () => {
    expect(hasRollbackAvailable('p', new Date(Date.now() - 29 * DAY))).toBe(true);
    expect(hasRollbackAvailable('p', new Date(Date.now() - 31 * DAY))).toBe(false);
    expect(hasRollbackAvailable(null, new Date())).toBe(false);
  });
  it('plan gating', () => {
    expect(hasFeature('starter', 'ai_chat')).toBe(false);
    expect(hasFeature('growth', 'ai_chat')).toBe(true);
    expect(hasFeature('growth', 'retrospective')).toBe(false);
    expect(hasFeature('watchtower', 'cross_tool_sla')).toBe(true);
    expect(recommendationLevelAllowed('starter', 2)).toBe(false);
    expect(recommendationLevelAllowed('growth', 3)).toBe(false);
    expect(recommendationLevelAllowed('watchtower', 4)).toBe(true);
  });
  it('insufficient evidence threshold: 100 leads or 14 days', () => {
    expect(hasSufficientEvidence(23, 5)).toBe(false);
    expect(hasSufficientEvidence(100, 1)).toBe(true);
    expect(hasSufficientEvidence(10, 14)).toBe(true);
  });
});

describe('insight ordering', () => {
  it('Priority Flag first, then red → amber → blue → green, monitoring last', () => {
    const t = (h: number) => new Date(Date.UTC(2026, 8, 26, h));
    const list = orderInsights([
      { id: 'g', type: 'win', severity: 'green', generatedAt: t(9) },
      { id: 'ie', type: 'insufficient_evidence', severity: 'blue', generatedAt: t(11) },
      { id: 'a', type: 'alert', severity: 'amber', generatedAt: t(10) },
      { id: 'pf', type: 'priority_flag', severity: 'red', generatedAt: t(1) },
      { id: 'r', type: 'alert', severity: 'red', generatedAt: t(8) },
      { id: 'r2', type: 'alert', severity: 'red', generatedAt: t(12) },
    ]);
    expect(list.map((x) => x.id)).toEqual(['pf', 'r2', 'r', 'a', 'g', 'ie']);
  });
});
