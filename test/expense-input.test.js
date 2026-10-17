'use strict';

const assert = require('node:assert/strict');
const { validateNewExpense, parseExpenseListQuery } = require('../expense-input');

const TODAY = '2026-10-16';

function ok(body) {
    const result = validateNewExpense(body, TODAY);
    assert.equal(result.ok, true, `expected ${JSON.stringify(body)} to be valid, got ${JSON.stringify(result)}`);
    return result.value;
}

function bad(body, messagePart) {
    const result = validateNewExpense(body, TODAY);
    assert.equal(result.ok, false, `expected ${JSON.stringify(body)} to be rejected`);
    assert.ok(result.error.includes(messagePart), `error "${result.error}" should mention "${messagePart}"`);
}

// הוצאה תקינה: ערכים מנוקים, תאריך ברירת מחדל = היום
assert.deepEqual(
    ok({ amount: '120.5', category: '  סופר ', description: ' קניות ', date: '2026-10-15' }),
    { amount: 120.5, category: 'סופר', description: 'קניות', date: '2026-10-15' }
);
assert.equal(ok({ amount: 50, category: 'קפה' }).date, TODAY, 'missing date means today');
assert.equal(ok({ amount: 50, category: 'קפה', date: '' }).date, TODAY, 'empty date means today');
assert.equal(ok({ amount: 50, category: 'קפה', date: TODAY }).date, TODAY, 'today is allowed');
assert.equal(ok({ amount: '12,5', category: 'קפה' }).amount, 12.5, 'decimal comma is accepted');
assert.equal(ok({ amount: '10.005', category: 'קפה' }).amount, 10.01, 'amount is rounded to agorot');
assert.equal(ok({ amount: 5, category: 'קפה' }).description, '', 'description is optional');

// סכום
bad({ category: 'סופר' }, 'סכום');
bad({ amount: '', category: 'סופר' }, 'סכום');
bad({ amount: 'abc', category: 'סופר' }, 'סכום');
bad({ amount: '0', category: 'סופר' }, 'סכום');
bad({ amount: '-20', category: 'סופר' }, 'סכום');
bad({ amount: 'Infinity', category: 'סופר' }, 'סכום');
bad({ amount: '99999999999', category: 'סופר' }, 'גדול מדי');

// קטגוריה ותיאור
bad({ amount: 10 }, 'קטגוריה');
bad({ amount: 10, category: '   ' }, 'קטגוריה');
bad({ amount: 10, category: 'א'.repeat(51) }, 'ארוך מדי');
bad({ amount: 10, category: 'סופר', description: 'א'.repeat(201) }, 'ארוך מדי');
bad({ amount: 10, category: ['סופר'] }, 'קטגוריה');

// תאריך
bad({ amount: 10, category: 'סופר', date: '2026-10-17' }, 'עתידי');
bad({ amount: 10, category: 'סופר', date: '2026-02-30' }, 'לא תקין');
bad({ amount: 10, category: 'סופר', date: '15/10/2026' }, 'לא תקין');
bad({ amount: 10, category: 'סופר', date: '1999-12-31' }, 'ישן מדי');

// גוף בקשה חסר או לא אובייקט
bad(undefined, 'סכום');
bad(null, 'סכום');
bad('text', 'סכום');

// סינון רשימת ההוצאות (?category=...&month=...)
const MONTH = '2026-10';
const filterValue = query => {
    const result = parseExpenseListQuery(query, MONTH);
    assert.equal(result.ok, true, `expected ${JSON.stringify(query)} to be accepted`);
    return result.value;
};
assert.deepEqual(filterValue({}), { category: null, month: null }, 'no params: no filter (the plain latest-100 list)');
assert.deepEqual(filterValue(undefined), { category: null, month: null });
assert.deepEqual(filterValue({ category: '  סופר ' }), { category: 'סופר', month: MONTH }, 'category alone means the current month');
assert.deepEqual(filterValue({ category: 'סופר', month: '2026-09' }), { category: 'סופר', month: '2026-09' });
assert.deepEqual(filterValue({ month: '2026-09' }), { category: null, month: '2026-09' });
assert.deepEqual(filterValue({ category: '   ' }), { category: null, month: null }, 'a blank category is no filter');
assert.deepEqual(filterValue({ category: ['a', 'b'] }), { category: null, month: null }, 'repeated params are ignored');
for (const month of ['2026-13', '2026-00', '2026-1', '2026-10-01', 'october', '../etc']) {
    assert.equal(parseExpenseListQuery({ month }, MONTH).ok, false, `month "${month}" must be rejected`);
}
assert.equal(parseExpenseListQuery({ category: 'א'.repeat(201) }, MONTH).ok, false);
assert.equal(parseExpenseListQuery({ category: 'א'.repeat(200) }, MONTH).ok, true);

console.log('Expense input validation tests passed');
