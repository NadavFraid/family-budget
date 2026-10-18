'use strict';

const assert = require('node:assert/strict');
const { validateLoan } = require('../loan-input');

const base = { lender: 'בנק הפועלים', principal: '50000', total_payments: '36' };
const ok = body => {
    const r = validateLoan(body);
    assert.equal(r.ok, true, `expected ${JSON.stringify(body)} to be valid, got ${JSON.stringify(r)}`);
    return r.value;
};
const bad = (body, part) => {
    const r = validateLoan(body);
    assert.equal(r.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    assert.ok(r.error.includes(part), `error "${r.error}" should mention "${part}"`);
};

// הלוואה מינימלית: שאר השדות מקבלים ברירות מחדל
assert.deepEqual(ok(base), {
    lender: 'בנק הפועלים', principal: 50000, start_date: null, total_payments: 36, paid_payments: 0, monthly_payment: null, notes: ''
});

// הלוואה מלאה, כולל פסיק עשרוני ורווחים
assert.deepEqual(
    ok({ lender: '  אמא ', principal: '12,500.5', total_payments: 10, paid_payments: '4', monthly_payment: '1300,25', start_date: '2026-03-15', notes: '  בלי ריבית ' }),
    { lender: 'אמא', principal: 12500.5, start_date: '2026-03-15', total_payments: 10, paid_payments: 4, monthly_payment: 1300.25, notes: 'בלי ריבית' }
);
assert.equal(ok({ ...base, principal: '50,000' }).principal, 50000, 'thousands separator');
assert.equal(ok({ ...base, principal: '1,250,000' }).principal, 1250000);
assert.equal(ok({ ...base, principal: '12,5' }).principal, 12.5, 'decimal comma');
assert.equal(ok({ ...base, paid_payments: '' }).paid_payments, 0, 'blank paid = 0');
assert.equal(ok({ ...base, monthly_payment: '' }).monthly_payment, null, 'blank monthly = none');
assert.equal(ok({ ...base, paid_payments: 36 }).paid_payments, 36, 'fully paid is allowed');
assert.equal(ok({ ...base, paid_payments: 0 }).paid_payments, 0);

// שדות חובה
bad({ ...base, lender: '' }, 'ממי');
bad({ ...base, lender: '   ' }, 'ממי');
bad({ ...base, lender: ['x'] }, 'ממי');
bad({ ...base, lender: 'א'.repeat(101) }, 'ארוך');
bad({ ...base, principal: '' }, 'סכום');
bad({ ...base, principal: '0' }, 'סכום');
bad({ ...base, principal: '-5' }, 'סכום');
bad({ ...base, principal: 'abc' }, 'סכום');
bad({ ...base, principal: 'Infinity' }, 'סכום');
bad({ ...base, principal: '99999999999' }, 'גדול');
bad({ ...base, total_payments: '' }, 'תשלומים');
bad({ ...base, total_payments: '0' }, 'תשלומים');
bad({ ...base, total_payments: '2.5' }, 'שלם');
bad({ ...base, total_payments: '601' }, 'גדול');
bad(undefined, 'ממי');
bad(null, 'ממי');
bad('text', 'ממי');

// תשלומים ששולמו
bad({ ...base, paid_payments: '37' }, 'גדול ממספר');
bad({ ...base, paid_payments: '-1' }, 'שלם');
bad({ ...base, paid_payments: '1.5' }, 'שלם');
bad({ ...base, paid_payments: 'abc' }, 'שלם');

// תשלום חודשי, תאריך והערות
bad({ ...base, monthly_payment: '0' }, 'חודשי');
bad({ ...base, monthly_payment: '-3' }, 'חודשי');
bad({ ...base, monthly_payment: 'abc' }, 'חודשי');
bad({ ...base, start_date: '2026-02-30' }, 'תאריך');
bad({ ...base, start_date: '15/03/2026' }, 'תאריך');
bad({ ...base, start_date: '1980-01-01' }, 'ישן');
assert.equal(ok({ ...base, start_date: '2099-01-01' }).start_date, '2099-01-01', 'a future start date is allowed (loan not started yet)');
bad({ ...base, notes: 'א'.repeat(501) }, 'ארוכות');

console.log('Loan input validation tests passed');
