'use strict';

const { isValidDateStr } = require('./expense-date-parser');

const MAX_ITEMS = 5000;
const MAPPING_FIELDS = ['date', 'merchant', 'amount', 'charge', 'currency', 'category', 'type', 'voucher', 'card', 'notes'];

// בדיקת הפריטים שהדפדפן שולח לאישור ייבוא; לא סומכים על מה שהוצג בתצוגה המקדימה
function validateImportItems(body) {
    const items = body && body.items;
    if (!Array.isArray(items) || items.length === 0) return { error: 'אין עסקאות לייבוא' };
    if (items.length > MAX_ITEMS) return { error: `אפשר לייבא עד ${MAX_ITEMS} עסקאות בבת אחת` };
    const clean = [];
    const keys = new Set();
    for (let i = 0; i < items.length; i += 1) {
        const it = items[i] || {};
        const label = `שורה ${i + 1}`;
        if (typeof it.key !== 'string' || !/^cc:[0-9a-f]{20}#\d{1,4}$/.test(it.key)) return { error: `${label}: מזהה עסקה לא תקין` };
        if (keys.has(it.key)) return { error: `${label}: עסקה כפולה בבקשה` };
        keys.add(it.key);
        if (typeof it.date !== 'string' || !isValidDateStr(it.date)) return { error: `${label}: תאריך לא תקין` };
        const amount = Number(it.amount);
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 10000000) return { error: `${label}: סכום לא תקין` };
        const category = typeof it.category === 'string' ? it.category.trim() : '';
        if (!category || category.length > 50) return { error: `${label}: קטגוריה חסרה או ארוכה מדי` };
        const description = typeof it.description === 'string' ? it.description.trim().slice(0, 200) : '';
        const merchant = typeof it.merchant === 'string' ? it.merchant.trim().slice(0, 200) : '';
        clean.push({
            key: it.key, date: it.date, amount: Math.round(amount * 100) / 100, category, description,
            merchant, learn: Boolean(it.learn) && merchant !== ''
        });
    }
    return { items: clean };
}

// מיפוי עמודות ידני: {date: 0, merchant: 1, amount: 2, ...} עם אינדקסים שלמים
function validateMapping(mapping) {
    if (!mapping || typeof mapping !== 'object') return null;
    const out = {};
    for (const field of MAPPING_FIELDS) {
        if (mapping[field] === undefined || mapping[field] === null || mapping[field] === '') continue;
        const n = Number(mapping[field]);
        if (!Number.isInteger(n) || n < 0 || n > 200) return null;
        out[field] = n;
    }
    if (out.date === undefined || out.merchant === undefined || (out.amount === undefined && out.charge === undefined)) return null;
    return out;
}

module.exports = { validateImportItems, validateMapping, MAPPING_FIELDS };
