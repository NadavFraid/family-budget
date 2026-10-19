'use strict';

const assert = require('node:assert/strict');
const { buildLoanForecast, addMonths } = require('../loan-schedule');

const loan = (over = {}) => ({ id: 1, lender: 'בנק', principal: 1200, total_payments: 12, paid_payments: 0, monthly_payment: 100, ...over });
const forecast = (loans, opts = {}) => buildLoanForecast(loans, { currentMonth: '2026-10', ...opts });

// חישוב חודשים
assert.equal(addMonths('2026-10', 0), '2026-10');
assert.equal(addMonths('2026-12', 1), '2027-01');
assert.equal(addMonths('2026-01', -1), '2025-12');
assert.equal(addMonths('2026-10', 25), '2028-11');
assert.equal(addMonths('2026-10', 3), '2027-01', 'year wrap');

// אין הלוואות פעילות
for (const input of [[], null, undefined, [loan({ paid_payments: 12 })]]) {
    const f = forecast(input);
    assert.deepEqual(f.months, []);
    assert.equal(f.summary, null);
}

// הלוואה אחת: 12 תשלומים, 4 שולמו, 8 נותרו, מתחיל החודש
let f = forecast([loan({ paid_payments: 4 })]);
assert.equal(f.months[0], '2026-10');
assert.equal(f.months[7], '2027-05', 'the 8th remaining payment');
assert.equal(f.months.length, 9, '8 payments + one trailing zero month');
assert.equal(f.months[8], '2027-06');
assert.deepEqual(f.totals, [100, 100, 100, 100, 100, 100, 100, 100, 0], 'falls to zero after the last payment');
assert.equal(f.loans[0].endMonth, '2027-05');
assert.equal(f.loans[0].estimated, false);
assert.equal(f.summary.currentMonthly, 100);
assert.equal(f.summary.remainingTotal, 800);
assert.equal(f.summary.lastPaymentMonth, '2027-05');
assert.equal(f.summary.monthsLeft, 8);
assert.deepEqual(f.steps, [{ from: '2026-10', to: '2027-05', amount: 100 }]);
assert.deepEqual(f.summary.nextDrop, { month: '2027-06', amount: 0, from: 100 });

// "התשלום הבא בחודש הבא" מזיז הכול חודש קדימה
f = forecast([loan({ paid_payments: 4 })], { startOffset: 1 });
assert.equal(f.months[0], '2026-11');
assert.equal(f.loans[0].endMonth, '2027-06');
assert.equal(f.summary.remainingTotal, 800, 'total does not depend on the offset');

// מעבר שנה
f = forecast([loan({ paid_payments: 9 })], { currentMonth: '2026-11' });
assert.deepEqual(f.months, ['2026-11', '2026-12', '2027-01', '2027-02']);
assert.equal(f.loans[0].endMonth, '2027-01');

// שתי הלוואות: ההחזר החודשי יורד כשהראשונה נגמרת
f = forecast([
    loan({ id: 1, lender: 'א', monthly_payment: 100, total_payments: 12, paid_payments: 10 }),   // 2 נותרו
    loan({ id: 2, lender: 'ב', monthly_payment: 50, total_payments: 6, paid_payments: 2 })       // 4 נותרו
]);
assert.deepEqual(f.totals, [150, 150, 50, 50, 0]);
assert.deepEqual(f.steps, [
    { from: '2026-10', to: '2026-11', amount: 150 },
    { from: '2026-12', to: '2027-01', amount: 50 }
]);
assert.deepEqual(f.summary.nextDrop, { month: '2026-12', amount: 50, from: 150 });
assert.equal(f.summary.remainingTotal, 100 * 2 + 50 * 4);
assert.deepEqual(f.loans.map(l => l.amounts), [[100, 100, 0, 0, 0], [50, 50, 50, 50, 0]]);
assert.deepEqual(f.loans.map(l => l.endMonth), ['2026-11', '2027-01']);
for (let i = 0; i < f.months.length; i += 1) {
    assert.equal(f.loans.reduce((s, l) => s + l.amounts[i], 0), f.totals[i], 'stack sums to the total');
}

// הלוואה בלי תשלום חודשי: קרן ÷ תשלומים, מסומנת כהערכה
f = forecast([loan({ id: 3, lender: 'הורים', principal: 1000, total_payments: 4, paid_payments: 1, monthly_payment: null })]);
assert.equal(f.loans[0].estimated, true);
assert.equal(f.loans[0].payment, 250);
assert.equal(f.summary.estimatedCount, 1);
assert.deepEqual(f.summary.estimatedLenders, ['הורים']);
assert.equal(f.summary.remainingTotal, 750);

// בלי חלוקה שווה: מעגלים לאגורה, והסכום הכולל נשאר עקבי
f = forecast([loan({ principal: 100, total_payments: 3, paid_payments: 0, monthly_payment: null })]);
assert.equal(f.loans[0].payment, 33.33);
assert.equal(f.summary.remainingTotal, 99.99);

// שברי אגורות לא מצטברים לסטייה (0.1 + 0.2)
f = forecast([loan({ id: 1, monthly_payment: 0.1, total_payments: 1 }), loan({ id: 2, monthly_payment: 0.2, total_payments: 1 })]);
assert.equal(f.totals[0], 0.3);

// הלוואות סגורות לא מופיעות, ופעילות כן
f = forecast([loan({ id: 1, paid_payments: 12 }), loan({ id: 2, paid_payments: 11 })]);
assert.deepEqual(f.loans.map(l => l.id), [2]);
assert.equal(f.months.length, 2);

// הלוואה ארוכה מאוד נחתכת בבטחה (לא יוצרת מערך ענק)
f = forecast([loan({ total_payments: 600, paid_payments: 0 })]);
assert.equal(f.months.length, 601);

console.log('Loan schedule tests passed');
