'use strict';

// זיהוי תאריך בהודעת הוצאה ("אתמול 120 סופר", "80 דלק 15/10", "50 קפה לפני 3 ימים").
// הפונקציה מחזירה את התאריך (YYYY-MM-DD) ואת הטקסט שנשאר אחרי הסרת התאריך,
// כדי שהסכום והקטגוריה ייקראו מהטקסט הנקי (תאריך כמו 15.10 לא יתפרש כסכום).

const DEFAULT_TZ = 'Asia/Jerusalem';
const MAX_DAYS_BACK = 366;

// JavaScript's \b does not work with Hebrew, so word boundaries are explicit.
const B = '(?<![\\p{L}\\p{N}_])';
const A = '(?![\\p{L}\\p{N}_])';

const RELATIVE_PATTERNS = [
    { re: new RegExp(`${B}לפני\\s+(\\d{1,3})\\s+ימים${A}`, 'u'), days: m => parseInt(m[1], 10) },
    { re: new RegExp(`${B}לפני\\s+יומיים${A}`, 'u'), days: () => 2 },
    { re: new RegExp(`${B}לפני\\s+יום${A}`, 'u'), days: () => 1 },
    { re: new RegExp(`${B}שלשום${A}`, 'u'), days: () => 2 },
    { re: new RegExp(`${B}אתמול${A}`, 'u'), days: () => 1 },
    { re: new RegExp(`${B}היום${A}`, 'u'), days: () => 0 }
];

// d/m, d.m, d/m/yy, d/m/yyyy, d.m.yy, d.m.yyyy
const EXPLICIT_SOURCE = '(?<![\\d./])(\\d{1,2})([./])(\\d{1,2})(?:\\2(\\d{4}|\\d{2}))?(?!\\d|[./]\\d)';

function pad(n) {
    return String(n).padStart(2, '0');
}

function todayInTz(tz = DEFAULT_TZ) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

function buildDate(year, month, day) {
    const dt = new Date(Date.UTC(year, month - 1, day));
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
}

function isValidDateStr(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof value === 'string' ? value : '');
    return Boolean(m) && buildDate(Number(m[1]), Number(m[2]), Number(m[3])) === value;
}

function shiftDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + delta));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function formatDisplayDate(dateStr) {
    const [y, m, d] = dateStr.split('-');
    return `${Number(d)}/${Number(m)}/${y}`;
}

function removeMatch(text, match) {
    const before = text.slice(0, match.index);
    const after = text.slice(match.index + match[0].length);
    // סימן פיסוק שצמוד לתאריך ("15/10.") נשאר צמוד למילה שלפניו, לא תלוי באוויר.
    const glue = /^\s*[.,;:!?]/.test(after) ? '' : ' ';
    return `${before.trimEnd()}${glue}${after.trimStart()}`.replace(/\s{2,}/g, ' ').trim();
}

/**
 * @param {string} text   שורת ההודעה
 * @param {string} today  התאריך של היום (YYYY-MM-DD) באזור הזמן של המשפחה
 * @returns {{date: string|null, rest: string, error: null|'invalid'|'future', match?: string}}
 *   date=null: לא נמצא תאריך. error: נמצא תאריך אבל הוא לא תקין / בעתיד (ההוצאה לא צריכה להירשם).
 */
function extractExpenseDate(text, today = todayInTz()) {
    const input = String(text ?? '');

    for (const pattern of RELATIVE_PATTERNS) {
        const m = pattern.re.exec(input);
        if (!m) continue;
        const days = pattern.days(m);
        if (!(days >= 0 && days <= MAX_DAYS_BACK)) continue;
        return { date: shiftDays(today, -days), rest: removeMatch(input, m), error: null };
    }

    const explicit = new RegExp(EXPLICIT_SOURCE, 'gu');
    let m;
    while ((m = explicit.exec(input)) !== null) {
        const day = Number(m[1]);
        const month = Number(m[3]);
        const separator = m[2];
        const yearText = m[4];
        const hasYear = yearText !== undefined;
        const rest = removeMatch(input, m);

        // "15.5 קפה" הוא סכום ולא 15 במאי: נקודה בלי שנה נחשבת תאריך רק אם יש בהודעה מספר נוסף (הסכום).
        // סלאש או שנה מפורשת אינם יכולים להיות סכום, ולכן שם ערך לא תקין הוא שגיאה ולא התעלמות.
        const ambiguous = separator === '.' && !hasYear;
        if (ambiguous && !/\d/.test(rest)) continue;

        let date = null;
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            if (hasYear) {
                const year = yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
                date = buildDate(year, month, day);
                if (date && date > today) return { date: null, rest: input, error: 'future', match: m[0] };
            } else {
                const year = Number(today.slice(0, 4));
                date = buildDate(year, month, day);
                // יום ללא שנה שעדיין לא הגיע השנה (למשל 28/12 בינואר) הוא של השנה שעברה.
                if (date && date > today) date = buildDate(year - 1, month, day);
            }
        }

        if (date) return { date, rest, error: null };
        if (ambiguous) continue;
        return { date: null, rest: input, error: 'invalid', match: m[0] };
    }

    return { date: null, rest: input.trim(), error: null };
}

module.exports = {
    extractExpenseDate,
    isValidDateStr,
    shiftDays,
    formatDisplayDate,
    todayInTz
};
