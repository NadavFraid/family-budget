'use strict';

const { isValidDateStr } = require('./expense-date-parser');

const MAX_LENDER_LENGTH = 100;
const MAX_NOTES_LENGTH = 500;
const MAX_AMOUNT = 1000000000;
const MAX_PAYMENTS = 600;
const MIN_DATE = '1990-01-01';

// ממיר קלט (מספר או מחרוזת, עם פסיק עשרוני) למספר; מחרוזת ריקה/חסרה = null; כל דבר אחר שאינו מספר = NaN
function parseNumber(value) {
    if (value === undefined || value === null) return null;
    // "50,000" ו-"12,500.5" הם סכומים עם פסיק אלפים; "12,5" הוא פסיק עשרוני
    const text = typeof value === 'number' ? '' : String(value).trim();
    const raw = typeof value === 'number' ? value : (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.'));
    if (raw === '') return null;
    return Number(raw);
}

/**
 * בדיקת קלט להלוואה (הוספה או עריכה).
 * חובה: מי נתן את ההלוואה, סכום, מספר תשלומים כולל. אופציונלי: תאריך התחלה, תשלום חודשי, הערות.
 * מספר התשלומים ששולמו הוא 0 אם לא הוזן, ולא יכול לעלות על המספר הכולל.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
function validateLoan(body) {
    const input = body && typeof body === 'object' ? body : {};

    const lender = typeof input.lender === 'string' ? input.lender.trim() : '';
    if (!lender) return { ok: false, error: 'יש להזין ממי נלקחה ההלוואה' };
    if (lender.length > MAX_LENDER_LENGTH) return { ok: false, error: `שם המלווה ארוך מדי (עד ${MAX_LENDER_LENGTH} תווים)` };

    const principal = parseNumber(input.principal);
    if (principal === null || !Number.isFinite(principal) || principal <= 0) return { ok: false, error: 'יש להזין סכום הלוואה גדול מאפס' };
    if (principal > MAX_AMOUNT) return { ok: false, error: 'סכום ההלוואה גדול מדי' };

    const totalPayments = parseNumber(input.total_payments);
    if (totalPayments === null || !Number.isInteger(totalPayments) || totalPayments < 1) return { ok: false, error: 'מספר התשלומים הכולל חייב להיות מספר שלם, 1 לפחות' };
    if (totalPayments > MAX_PAYMENTS) return { ok: false, error: `מספר התשלומים הכולל גדול מדי (עד ${MAX_PAYMENTS})` };

    const paidRaw = parseNumber(input.paid_payments);
    const paidPayments = paidRaw === null ? 0 : paidRaw;
    if (!Number.isInteger(paidPayments) || paidPayments < 0) return { ok: false, error: 'מספר התשלומים ששולמו חייב להיות מספר שלם, 0 או יותר' };
    if (paidPayments > totalPayments) return { ok: false, error: 'מספר התשלומים ששולמו גדול ממספר התשלומים הכולל' };

    const monthlyRaw = parseNumber(input.monthly_payment);
    if (monthlyRaw !== null && (!Number.isFinite(monthlyRaw) || monthlyRaw <= 0)) return { ok: false, error: 'התשלום החודשי חייב להיות גדול מאפס (או להישאר ריק)' };
    if (monthlyRaw !== null && monthlyRaw > MAX_AMOUNT) return { ok: false, error: 'התשלום החודשי גדול מדי' };

    const rawDate = typeof input.start_date === 'string' ? input.start_date.trim() : '';
    if (rawDate) {
        if (!isValidDateStr(rawDate)) return { ok: false, error: 'תאריך ההתחלה לא תקין' };
        if (rawDate < MIN_DATE) return { ok: false, error: 'תאריך ההתחלה ישן מדי' };
    }

    const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
    if (notes.length > MAX_NOTES_LENGTH) return { ok: false, error: `ההערות ארוכות מדי (עד ${MAX_NOTES_LENGTH} תווים)` };

    return {
        ok: true,
        value: {
            lender,
            principal: Math.round(principal * 100) / 100,
            start_date: rawDate || null,
            total_payments: totalPayments,
            paid_payments: paidPayments,
            monthly_payment: monthlyRaw === null ? null : Math.round(monthlyRaw * 100) / 100,
            notes
        }
    };
}

module.exports = { validateLoan };
