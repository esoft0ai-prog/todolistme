import { fromHex, hmacSha256, pbkdf2Sha256, sha256Hex, timingSafeEqualHex, toHex, utf8 } from '../crypto';
import { buildHtmlReport, csvCell, escapeHtml, transactionsToCSV } from '../exporters';

describe('sha256 / hmac / pbkdf2 (standard test vectors)', () => {
  it('matches NIST SHA-256 vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with Node crypto for unicode and multi-block inputs', () => {
    const node = require('crypto');
    const samples = ['₦25,000 naira', '😀 emoji', 'x'.repeat(55), 'y'.repeat(64), 'z'.repeat(1000), 'Ọjà àti owó'];
    for (const s of samples) expect(sha256Hex(s)).toBe(node.createHash('sha256').update(s, 'utf8').digest('hex'));
  });

  it('matches RFC 4231 HMAC-SHA256 test case 2', () => {
    expect(toHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?')))).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('matches PBKDF2-HMAC-SHA256 vectors', () => {
    expect(toHex(pbkdf2Sha256(utf8('password'), utf8('salt'), 1, 32))).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    );
    expect(toHex(pbkdf2Sha256(utf8('password'), utf8('salt'), 4096, 32))).toBe(
      'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
    );
  });

  it('hex helpers and constant time compare', () => {
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
    expect(() => fromHex('zz')).toThrow();
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
  });
});

describe('CSV export', () => {
  it('escapes quotes, commas and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+2+3')).toBe("'+2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-250.5')).toBe('-250.5'); // plain negative numbers stay numeric
  });

  it('exports transactions with a BOM and major-unit amounts', () => {
    const csv = transactionsToCSV([
      {
        date: '2026-03-01',
        time: '10:30',
        type: 'expense',
        amountMinor: 250_050,
        currency: 'NGN',
        baseAmountMinor: 250_050,
        baseCurrency: 'NGN',
        account: 'Cash',
        toAccount: null,
        category: 'Food',
        description: 'Rice, beans',
        paymentMethod: 'cash',
        tags: ['market', 'family'],
        notes: null,
        reference: null,
        debt: null,
        goal: null,
      },
    ]);
    expect(csv.startsWith('﻿Date,Time,Type,Amount')).toBe(true);
    expect(csv).toContain('2026-03-01,10:30,expense,2500.5,NGN,2500.5,NGN,Cash,,Food,"Rice, beans",cash,market; family');
  });
});

describe('HTML report', () => {
  it('escapes user content', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    const html = buildHtmlReport({
      title: 'Report',
      generatedAt: '2026-03-01T10:00:00.000Z',
      currency: 'NGN',
      range: { start: '2026-03-01', end: '2026-03-31' },
      totals: { incomeMinor: 100, expenseMinor: 50, debtRepaymentMinor: 0, loanReceivedMinor: 0, savingsNetMinor: 0 },
      balances: [{ name: '<b>Cash</b>', type: 'cash', balanceMinor: 50, currency: 'NGN' }],
      categories: [],
      incomeCategories: [],
      months: [],
      debts: [],
      goals: [],
      budgets: [],
      health: null,
      topExpenses: [],
    });
    expect(html).toContain('&lt;b&gt;Cash&lt;/b&gt;');
    expect(html).not.toContain('<b>Cash</b>');
    expect(html).toContain("default-src 'none'");
  });
});
