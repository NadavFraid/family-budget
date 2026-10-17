'use strict';

const { isValidDateStr, todayInTz } = require('./expense-date-parser');

const MAX_AMOUNT = 10000000;
const MAX_CATEGORY_LENGTH = 50;
const MAX_DESCRIPTION_LENGTH = 200;
const MIN_DATE = '2000-01-01';
// קטגוריות שנוצרות מהודעות וואטסאפ יכולות להיות ארוכות יותר, לכן הסינון מקבל יותר מ-MAX_CATEGORY_LENGTH
const MAX_FILTER_CATEGORY_LENGTH = 200;
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * פענוח פרמטרי הסינון של רשימת ההוצאות (?category=...&month=YYYY-MM).
 * בלי month ועם category: החודש הנוכחי (כמו העוגה באתר). בלי שניהם: אין סינון.
 * @returns {{ok: true, value: {category: string|null, month: string|null}} | {ok: false, error: string}}
 */
function parseExpenseListQuery(query, currentMonth) {
    const input = query && typeof query === 'object' ? query : {};
    const category = typeof input.category === 'string' ? input.category.trim() : '';
    const month = typeof input.month === 'string' ? input.month.trim() : '';

    if (category.length > MAX_FILTER_CATEGORY_LENGTH) return { ok: false, error: 'שם הקטגוריה ארוך מדי' };
    if (month && !MONTH_PATTERN.test(month)) return { ok: false, error: 'פורמט חודש לא תקין (YYYY-MM)' };

    return {
        ok: true,
        value: { category: category || null, month: month || (category ? currentMonth : null) }
    };
}

/**
 * בדיקת קלט להוספת הוצאה ידנית מהאתר.
 * @returns {{ok: true, value: {amount: number, category: string, description: string, date: string}} | {ok: false, error: string}}
 */
function validateNewExpense(body, today = todayInTz()) {
    const input = body && typeof body === 'object' ? body : {};

    const rawAmount = typeof input.amount === 'number' ? input.amount : String(input.amount ?? '').trim().replace(',', '.');
    const amount = rawAmount === '' ? NaN : Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'יש להזין סכום גדול מאפס' };
    if (amount > MAX_AMOUNT) return { ok: false, error: 'הסכום גדול מדי' };

    const category = typeof input.category === 'string' ? input.category.trim() : '';
    if (!category) return { ok: false, error: 'יש לבחור או להזין קטגוריה' };
    if (category.length > MAX_CATEGORY_LENGTH) return { ok: false, error: `שם הקטגוריה ארוך מדי (עד ${MAX_CATEGORY_LENGTH} תווים)` };

    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length > MAX_DESCRIPTION_LENGTH) return { ok: false, error: `התיאור ארוך מדי (עד ${MAX_DESCRIPTION_LENGTH} תווים)` };

    const rawDate = typeof input.date === 'string' ? input.date.trim() : '';
    const date = rawDate || today;
    if (!isValidDateStr(date)) return { ok: false, error: 'תאריך לא תקין' };
    if (date > today) return { ok: false, error: 'אי אפשר להזין הוצאה בתאריך עתידי' };
    if (date < MIN_DATE) return { ok: false, error: 'התאריך ישן מדי' };

    return {
        ok: true,
        value: { amount: Math.round(amount * 100) / 100, category, description, date }
    };
}

/**
 * בדיקת קלט לעריכת הוצאה קיימת: אותם כללים כמו הוספה, אבל התאריך חובה
 * (עריכה בלי תאריך לא אמורה להזיז את ההוצאה להיום בשקט).
 */
function validateExpenseUpdate(body, today = todayInTz()) {
    const input = body && typeof body === 'object' ? body : {};
    if (typeof input.date !== 'string' || !input.date.trim()) return { ok: false, error: 'יש לבחור תאריך' };
    return validateNewExpense(input, today);
}

module.exports = { validateNewExpense, validateExpenseUpdate, parseExpenseListQuery };
