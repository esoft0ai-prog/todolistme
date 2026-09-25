import {
  amortizedPayment,
  computeTotalInterest,
  computeTotalPayable,
  debtToIncome,
  deriveInstallmentCount,
  paymentPunctuality,
  penaltyFor,
  summarizeDebt,
  validateDebt,
  validateRepayment,
} from '../debt';
import type { Debt, DebtPayment } from '../types';

const NOW = '2026-01-01T00:00:00.000Z';

export function makeDebt(p: Partial<Debt> = {}): Debt {
  return {
    id: 'd1',
    lenderName: 'QuickCash',
    debtType: 'loan_app',
    currency: 'NGN',
    principalMinor: 10_000_000, // ₦100,000
    interestType: 'none',
    interestValue: 0,
    paymentFrequency: 'monthly',
    minimumPaymentMinor: 0,
    installmentCount: 4,
    startDate: '2026-01-01',
    firstDueDate: '2026-02-01',
    endDate: null,
    penaltyType: 'none',
    penaltyValue: 0,
    paidBeforeMinor: 0,
    notes: null,
    status: 'active',
    totalPayableOverrideMinor: null,
    isDemo: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...p,
  };
}

const pay = (amount: number, date: string, kind: DebtPayment['kind'] = 'payment'): DebtPayment => ({
  id: `${kind}-${date}-${amount}`,
  debtId: 'd1',
  kind,
  amountMinor: amount,
  date,
  transactionId: null,
  notes: null,
  isDemo: false,
  createdAt: NOW,
  updatedAt: NOW,
});

describe('interest models', () => {
  it('computes zero, fixed and flat percentage interest', () => {
    expect(computeTotalInterest(makeDebt())).toBe(0);
    expect(computeTotalInterest(makeDebt({ interestType: 'fixed_amount', interestValue: 500_000 }))).toBe(500_000);
    expect(computeTotalInterest(makeDebt({ interestType: 'flat_percentage', interestValue: 15 }))).toBe(1_500_000);
  });

  it('computes simple annual interest over the loan term', () => {
    // 12 monthly instalments starting one month after start → ~1 year term
    const d = makeDebt({ interestType: 'simple_annual', interestValue: 20, installmentCount: 12, startDate: '2026-01-01', firstDueDate: '2026-02-01' });
    const interest = computeTotalInterest(d);
    // Last instalment 2027-01-01 → 365-day term: 20% × ₦100k × 365/365.2425 ≈ ₦19,987
    expect(interest).toBe(Math.round((10_000_000 * 20 * (365 / 365.2425)) / 100));
  });

  it('computes amortised (reducing balance) interest', () => {
    const pmt = amortizedPayment(10_000_000, 24, 12, 12);
    expect(pmt).toBeCloseTo(945_596, -1); // standard annuity formula
    const d = makeDebt({ interestType: 'reducing_balance', interestValue: 24, installmentCount: 12 });
    expect(computeTotalInterest(d)).toBe(Math.round(pmt * 12 - 10_000_000));
    expect(amortizedPayment(1200, 0, 12, 12)).toBe(100);
  });

  it('uses user-defined schedules', () => {
    const d = makeDebt({ interestType: 'custom_schedule' });
    const schedule = [
      { id: 's1', debtId: 'd1', dueDate: '2026-03-01', amountMinor: 6_000_000 },
      { id: 's2', debtId: 'd1', dueDate: '2026-02-01', amountMinor: 5_000_000 },
    ];
    expect(computeTotalInterest(d, schedule)).toBe(1_000_000);
    const s = summarizeDebt(d, [], schedule, '2026-01-15');
    expect(s.installments.map((i) => i.dueDate)).toEqual(['2026-02-01', '2026-03-01']);
    expect(s.nextInstallment?.amountMinor).toBe(5_000_000);
  });

  it('honours a total payable override', () => {
    expect(computeTotalPayable(makeDebt({ totalPayableOverrideMinor: 12_345_600 }))).toBe(12_345_600);
  });
});

describe('instalment schedule & summary', () => {
  it('derives the number of instalments from an end date', () => {
    expect(deriveInstallmentCount(makeDebt({ installmentCount: 0, endDate: '2026-06-01' }))).toBe(5);
    expect(deriveInstallmentCount(makeDebt({ paymentFrequency: 'one_time' }))).toBe(1);
  });

  it('allocates payments to instalments and finds the next payment', () => {
    const d = makeDebt({ interestType: 'flat_percentage', interestValue: 20 }); // ₦120,000 over 4 months = ₦30,000
    const s = summarizeDebt(d, [pay(3_000_000, '2026-02-01'), pay(1_000_000, '2026-02-20')], [], '2026-02-25');
    expect(s.totalPayableMinor).toBe(12_000_000);
    expect(s.installmentAmountMinor).toBe(3_000_000);
    expect(s.outstandingMinor).toBe(8_000_000);
    expect(s.nextInstallment).toMatchObject({ dueDate: '2026-03-01', paidMinor: 1_000_000, status: 'partial' });
    expect(s.daysUntilNext).toBe(4);
    expect(s.paymentsRemaining).toBe(3);
    expect(s.scheduledPayoffDate).toBe('2026-05-01');
    expect(s.monthlyObligationMinor).toBe(3_000_000);
    expect(s.progress).toBeCloseTo(4 / 12);
  });

  it('detects overdue instalments', () => {
    const d = makeDebt();
    const s = summarizeDebt(d, [], [], '2026-02-04');
    expect(s.overdueInstallments).toHaveLength(1);
    expect(s.daysOverdue).toBe(3);
    expect(s.overdueAmountMinor).toBe(2_500_000);
    expect(s.nextInstallment?.status).toBe('overdue');
  });

  it('applies penalties and marks paid off', () => {
    const d = makeDebt({ installmentCount: 1, paymentFrequency: 'one_time' });
    const withPenalty = summarizeDebt(d, [pay(500_000, '2026-02-05', 'penalty')], [], '2026-02-06');
    expect(withPenalty.outstandingMinor).toBe(10_500_000);
    const paid = summarizeDebt(d, [pay(500_000, '2026-02-05', 'penalty'), pay(10_500_000, '2026-02-06')], [], '2026-02-06');
    expect(paid.outstandingMinor).toBe(0);
    expect(paid.isPaidOff).toBe(true);
    expect(paid.nextInstallment).toBeNull();
    expect(paid.monthlyObligationMinor).toBe(0);
  });

  it('accounts for amounts paid before tracking', () => {
    const s = summarizeDebt(makeDebt({ paidBeforeMinor: 5_000_000 }), [], [], '2026-01-10');
    expect(s.outstandingMinor).toBe(5_000_000);
    expect(s.paymentsRemaining).toBe(2);
    expect(s.nextInstallment?.dueDate).toBe('2026-04-01');
  });

  it('extends the schedule when a fixed minimum payment is given', () => {
    const s = summarizeDebt(makeDebt({ minimumPaymentMinor: 3_000_000, installmentCount: 0 }), [], [], '2026-01-10');
    expect(s.installments.map((i) => i.amountMinor)).toEqual([3_000_000, 3_000_000, 3_000_000, 1_000_000]);
  });

  it('projects payoff from repayment pace', () => {
    const d = makeDebt({ installmentCount: 10, startDate: '2026-01-01' });
    const s = summarizeDebt(d, [pay(1_000_000, '2026-01-31')], [], '2026-03-01');
    // ₦10,000 repaid over 59 days → ₦90,000 left needs ~531 days
    expect(s.projectedPayoffDate! > '2027-07-01').toBe(true);
  });

  it('computes one-time debt monthly obligation spread to due date', () => {
    const d = makeDebt({ paymentFrequency: 'one_time', installmentCount: 1, firstDueDate: '2026-04-01' });
    const s = summarizeDebt(d, [], [], '2026-01-01');
    expect(s.monthlyObligationMinor).toBe(Math.round(10_000_000 / 3));
  });
});

describe('ratios, penalties and punctuality', () => {
  it('computes DTI', () => {
    expect(debtToIncome(30_000, 100_000)).toBeCloseTo(0.3);
    expect(debtToIncome(0, 0)).toBe(0);
    expect(debtToIncome(10, 0)).toBeNull();
  });

  it('computes penalties', () => {
    expect(penaltyFor({ penaltyType: 'fixed', penaltyValue: 200_000 }, 1_000_000)).toBe(200_000);
    expect(penaltyFor({ penaltyType: 'percentage', penaltyValue: 5 }, 1_000_000)).toBe(50_000);
    expect(penaltyFor({ penaltyType: 'none', penaltyValue: 5 }, 1_000_000)).toBe(0);
  });

  it('counts on-time and late payments', () => {
    const d = makeDebt(); // 4 × ₦25,000 from Feb 1
    const payments = [pay(2_500_000, '2026-02-01'), pay(2_500_000, '2026-03-05')];
    const p = paymentPunctuality(d, payments, [], '2026-01-01', '2026-04-10');
    expect(p).toEqual({ due: 3, onTime: 1, overdueNow: 1 });
  });
});

describe('validation', () => {
  it('rejects invalid debts', () => {
    const errors = validateDebt({ lenderName: '', principalMinor: 0, startDate: '2026-02-01', firstDueDate: '2026-01-01', interestValue: -1 });
    const fields = errors.map((e) => e.field);
    expect(fields).toEqual(expect.arrayContaining(['lenderName', 'principalMinor', 'firstDueDate', 'interestValue']));
    expect(validateDebt(makeDebt())).toEqual([]);
    expect(validateDebt(makeDebt({ paidBeforeMinor: 20_000_000 }))[0].field).toBe('paidBeforeMinor');
    expect(validateDebt(makeDebt({ interestType: 'custom_schedule' }))[0].field).toBe('schedule');
  });

  it('prevents repayments that make the balance negative', () => {
    expect(validateRepayment(100, 50)).toMatch(/larger/);
    expect(validateRepayment(0, 50)).toMatch(/greater than zero/);
    expect(validateRepayment(50, 50)).toBeNull();
  });
});
