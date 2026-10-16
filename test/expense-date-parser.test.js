'use strict';

const assert = require('node:assert/strict');
const { extractExpenseDate, isValidDateStr, shiftDays, formatDisplayDate } = require('../expense-date-parser');

const TODAY = '2026-10-16';

function parse(text, today = TODAY) {
    return extractExpenseDate(text, today);
}

function expectDate(text, date, rest, today = TODAY) {
    const result = parse(text, today);
    assert.equal(result.error, null, `"${text}" should not be an error`);
    assert.equal(result.date, date, `date of "${text}"`);
    assert.equal(result.rest, rest, `rest of "${text}"`);
}

function expectNoDate(text) {
    const result = parse(text);
    assert.equal(result.date, null, `"${text}" should have no date`);
    assert.equal(result.error, null, `"${text}" should not be an error`);
    assert.equal(result.rest, text.trim(), `"${text}" should stay untouched`);
}

function expectError(text, error) {
    const result = parse(text);
    assert.equal(result.date, null);
    assert.equal(result.error, error, `error of "${text}"`);
    assert.equal(result.rest, text, 'rest stays untouched on error');
}

// מילים יחסיות
expectDate('אתמול 120 סופר', '2026-10-15', '120 סופר');
expectDate('120 סופר אתמול', '2026-10-15', '120 סופר');
expectDate('120 אתמול סופר', '2026-10-15', '120 סופר');
expectDate('שלשום 50 קפה', '2026-10-14', '50 קפה');
expectDate('היום 50 קפה', '2026-10-16', '50 קפה');
expectDate('80 דלק לפני יומיים', '2026-10-14', '80 דלק');
expectDate('80 דלק לפני יום', '2026-10-15', '80 דלק');
expectDate('80 דלק לפני 3 ימים', '2026-10-13', '80 דלק');
expectDate('לפני 10 ימים 200 סופר', '2026-10-06', '200 סופר');
expectDate('אתמול 120 סופר', '2025-12-31', '120 סופר', '2026-01-01');
expectDate('שלשום 120 סופר', '2025-12-30', '120 סופר', '2026-01-01');
expectDate('אתמול 20 קפה', '2026-02-28', '20 קפה', '2026-03-01');
expectDate('אתמול 20 קפה', '2028-02-29', '20 קפה', '2028-03-01');

// "לפני N ימים" לא נספר כסכום, והמספר נשאר ללא פגיעה בטקסט שנותר
assert.equal(parse('80 דלק לפני 3 ימים').rest.match(/\d+/g).join(','), '80');

// גבולות מילים: "היומיום" אינו "היום"
expectNoDate('היומיום 50 פיצה');
expectNoDate('50 קפהאתמול');
// יותר משנה אחורה אינו נחשב תאריך
expectNoDate('לפני 400 ימים 50 קפה');

// תאריכים מפורשים
expectDate('120 סופר 15/10', '2026-10-15', '120 סופר');
expectDate('15/10 120 סופר', '2026-10-15', '120 סופר');
expectDate('120 סופר 5/10/2026', '2026-10-05', '120 סופר');
expectDate('120 סופר 5.10.26', '2026-10-05', '120 סופר');
expectDate('120 סופר 05.10.2026', '2026-10-05', '120 סופר');
expectDate('120 סופר 16/10', '2026-10-16', '120 סופר');
expectDate('120 סופר 1/1', '2026-01-01', '120 סופר');
expectDate('120 סופר 3/9/2025', '2025-09-03', '120 סופר');
expectDate('120 סופר 15/10.', '2026-10-15', '120 סופר.'.replace('.', '') + '.');

// נקודה עשרונית: סכום ולא תאריך כשאין מספר נוסף
expectNoDate('15.5 קפה');
expectNoDate('5.10 קפה');
expectNoDate('120.50 סופר');
expectNoDate('99.9 דלק');
// עם מספר נוסף (הסכום) נקודה היא תאריך
expectDate('120 סופר 12.5', '2026-05-12', '120 סופר');
expectDate('12.5 120 סופר', '2026-05-12', '120 סופר');
// מספר אחר (לא תאריך) נשאר שלם
expectNoDate('120 סופר');
expectNoDate('50 קפה');

// יום שעוד לא הגיע השנה שייך לשנה שעברה
expectDate('120 סופר 28/12', '2025-12-28', '120 סופר');
expectDate('120 סופר 28/12', '2025-12-28', '120 סופר', '2026-01-03');
expectDate('120 סופר 29/2', '2028-02-29', '120 סופר', '2028-03-10');

// שגיאות
expectError('120 סופר 31/2', 'invalid');
expectError('120 סופר 13/13', 'invalid');
expectError('120 סופר 0/5', 'invalid');
expectError('120 סופר 31.2.2026', 'invalid');
expectError('120 סופר 29/2', 'invalid');
expectError('120 סופר 1/1/2027', 'future');
expectError('120 סופר 17/10/2026', 'future');
expectError('120 סופר 17.10.26', 'future');

// עזרים
assert.equal(shiftDays('2026-03-01', -1), '2026-02-28');
assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
assert.equal(isValidDateStr('2026-10-16'), true);
assert.equal(isValidDateStr('2026-02-30'), false);
assert.equal(isValidDateStr('2026-1-5'), false);
assert.equal(isValidDateStr(null), false);
assert.equal(formatDisplayDate('2026-10-05'), '5/10/2026');

console.log('Expense date parser tests passed');
