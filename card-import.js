'use strict';

// ייבוא קובצי פירוט עסקאות מחברות כרטיסי אשראי (ישראכרט/אמקס, כאל ועוד).
// בלי תלויות חיצוניות: קורא xlsx (zip + XML) ו-csv בעצמו, ומזהה את העמודות לפי הכותרות בעברית.
// הקובץ הזה לא נוגע במסד הנתונים; הוא רק הופך קובץ לרשימת עסקאות מסודרת.

const zlib = require('zlib');
const crypto = require('crypto');
const { isValidDateStr } = require('./expense-date-parser');

const MAX_ROWS = 20000;

// ---------------------------------------------------------------- xlsx

function decodeXml(text) {
    return String(text)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// קורא את רשימת הקבצים ב-zip (לפי ה-central directory) ומחזיר פונקציה שפותחת קובץ לפי שם
function openZip(buffer) {
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('הקובץ אינו קובץ Excel תקין (xlsx)');
    const count = buffer.readUInt16LE(eocd + 10);
    let pos = buffer.readUInt32LE(eocd + 16);
    const entries = new Map();
    for (let n = 0; n < count; n += 1) {
        if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('קובץ ה-Excel פגום');
        const method = buffer.readUInt16LE(pos + 10);
        const compSize = buffer.readUInt32LE(pos + 20);
        const nameLen = buffer.readUInt16LE(pos + 28);
        const extraLen = buffer.readUInt16LE(pos + 30);
        const commentLen = buffer.readUInt16LE(pos + 32);
        const localOffset = buffer.readUInt32LE(pos + 42);
        const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
        entries.set(name, { method, compSize, localOffset });
        pos += 46 + nameLen + extraLen + commentLen;
    }
    return {
        has: name => entries.has(name),
        names: () => [...entries.keys()],
        read(name) {
            const e = entries.get(name);
            if (!e) return null;
            const local = e.localOffset;
            if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('קובץ ה-Excel פגום');
            const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
            const raw = buffer.subarray(start, start + e.compSize);
            if (e.method === 0) return raw.toString('utf8');
            if (e.method === 8) return zlib.inflateRawSync(raw).toString('utf8');
            throw new Error('שיטת דחיסה לא נתמכת בקובץ ה-Excel');
        }
    };
}

function colIndex(ref) {
    const letters = /^[A-Z]+/.exec(ref)[0];
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormatCode(code) {
    const stripped = String(code).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
    return /[dy]/i.test(stripped);
}

function readStyles(xml) {
    if (!xml) return () => false;
    const custom = new Map();
    for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) custom.set(Number(m[1]), decodeXml(m[2]));
    const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    const xfIsDate = [];
    if (cellXfs) {
        for (const m of cellXfs[1].matchAll(/<xf\b[^>]*?numFmtId="(\d+)"/g)) {
            const id = Number(m[1]);
            xfIsDate.push(custom.has(id) ? isDateFormatCode(custom.get(id)) : BUILTIN_DATE_FORMATS.has(id));
        }
    }
    return styleIndex => Boolean(xfIsDate[styleIndex]);
}

function excelSerialToIso(serial) {
    const ms = Math.round((Math.floor(serial) - 25569) * 86400000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

function readSharedStrings(xml) {
    if (!xml) return [];
    const out = [];
    for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
        let text = '';
        for (const t of si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
        out.push(decodeXml(text));
    }
    return out;
}

function readSheetRows(xml, shared, isDateStyle) {
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const body = rowMatch[1];
        if (!body) { rows.push([]); continue; }
        const rowIdx = /\br="(\d+)"/.exec(rowMatch[0].slice(0, 200));
        const cells = [];
        for (const c of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
            const attrs = c[1];
            const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
            if (!ref) continue;
            const type = (/\bt="([^"]*)"/.exec(attrs) || [])[1];
            const style = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] || 0);
            const inner = c[2] || '';
            let value = null;
            if (type === 'inlineStr') {
                value = decodeXml([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
            } else {
                const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
                if (v) {
                    if (type === 's') value = shared[Number(v[1])] ?? '';
                    else if (type === 'str' || type === 'e') value = decodeXml(v[1]);
                    else if (type === 'b') value = v[1] === '1' ? 'TRUE' : 'FALSE';
                    else {
                        const num = Number(v[1]);
                        value = Number.isFinite(num) ? (isDateStyle(style) ? (excelSerialToIso(num) || num) : num) : decodeXml(v[1]);
                    }
                }
            }
            cells[colIndex(ref[1])] = value;
        }
        const target = rowIdx ? Number(rowIdx[1]) - 1 : rows.length;
        while (rows.length < target) rows.push([]);
        rows.push(cells);
        if (rows.length > MAX_ROWS) throw new Error('הקובץ גדול מדי');
    }
    return rows;
}

function readXlsx(buffer) {
    const zip = openZip(buffer);
    if (!zip.has('xl/workbook.xml')) throw new Error('הקובץ אינו קובץ Excel תקין (xlsx)');
    const shared = readSharedStrings(zip.read('xl/sharedStrings.xml'));
    const isDateStyle = readStyles(zip.read('xl/styles.xml'));
    const rels = new Map();
    for (const m of (zip.read('xl/_rels/workbook.xml.rels') || '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
        const id = /\bId="([^"]*)"/.exec(m[1]);
        const target = /\bTarget="([^"]*)"/.exec(m[1]);
        if (id && target) rels.set(id[1], target[1].replace(/^\/?(xl\/)?/, 'xl/'));
    }
    const sheets = [];
    for (const m of zip.read('xl/workbook.xml').matchAll(/<sheet\b([^>]*)\/?>/g)) {
        const name = decodeXml((/\bname="([^"]*)"/.exec(m[1]) || [])[1] || '');
        const rid = (/\br:id="([^"]*)"/.exec(m[1]) || [])[1];
        const file = rels.get(rid);
        const xml = file && zip.read(file);
        if (xml) sheets.push({ name, rows: readSheetRows(xml, shared, isDateStyle) });
    }
    return sheets;
}

// ---------------------------------------------------------------- csv / html

function decodeText(buffer) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (e) { text = new TextDecoder('windows-1255').decode(buffer); }
    return text.replace(/^﻿/, '');
}

function readCsv(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const delimiter = [',', ';', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === delimiter) { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            row.push(cell); cell = '';
            rows.push(row); row = [];
            if (rows.length > MAX_ROWS) throw new Error('הקובץ גדול מדי');
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

// חלק מהאתרים מייצאים "xls" שהוא בעצם טבלת HTML
function readHtmlTable(text) {
    const rows = [];
    for (const tr of text.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
        rows.push([...tr[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
            .map(m => decodeXml(m[1].replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')).replace(/\s+/g, ' ').trim()));
        if (rows.length > MAX_ROWS) throw new Error('הקובץ גדול מדי');
    }
    return rows;
}

/** @returns {Array<{name: string, rows: Array<Array<string|number|null>>}>} */
function readTabularFile(buffer, fileName = '') {
    if (!buffer || buffer.length === 0) throw new Error('הקובץ ריק');
    if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return readXlsx(buffer);
    if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0) {
        throw new Error('זהו קובץ xls בפורמט ישן. פתחו אותו ב-Excel ושמרו כ-xlsx (או כ-CSV), ואז העלו שוב.');
    }
    const text = decodeText(buffer);
    if (/<table\b/i.test(text.slice(0, 5000)) || /<tr\b/i.test(text.slice(0, 5000))) return [{ name: fileName, rows: readHtmlTable(text) }];
    return [{ name: fileName, rows: readCsv(text) }];
}

// ---------------------------------------------------------------- detection

function norm(value) {
    return String(value ?? '')
        .replace(/[‎‏‪-‮ ]/g, ' ')
        .replace(/["'`״׳]/g, '')
        .replace(/[.,:;()[\]\-–_/\\*]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

// כל כלל מקבל כותרת מנורמלת ומחזיר עדיפות (מספר גבוה = התאמה טובה יותר) או 0
const COLUMN_RULES = {
    chargeDate: n => (n.includes('תאריך') && n.includes('חיוב') ? 1 : 0),
    date: n => {
        if (!n.includes('תאריך') || n.includes('חיוב')) return 0;
        return n.includes('עסקה') || n.includes('רכישה') || n.includes('קניה') || n.includes('קנייה') ? 2 : 1;
    },
    merchant: n => {
        if (n.includes('בית עסק') || n.includes('שם בית') || n.includes('שם העסק') || n === 'שם עסק') return 2;
        return n === 'תיאור' || n === 'תיאור עסקה' || n === 'פרטים' ? 1 : 0;
    },
    charge: n => (n.includes('סכום') && n.includes('חיוב') ? 1 : 0),
    amount: n => {
        if (n.includes('חיוב')) return 0;
        if (n === 'סכום') return 1;
        return n.includes('סכום') && (n.includes('עסקה') || n.includes('קניה') || n.includes('קנייה') || n.includes('רכישה') || n.includes('מקורי')) ? 2 : 0;
    },
    currency: n => (n.includes('מטבע') ? (n.includes('עסקה') || n.includes('מקורי') ? 2 : 1) : 0),
    category: n => (n === 'ענף' || n === 'קטגוריה' || n === 'סוג בית עסק' ? 1 : 0),
    type: n => (n === 'סוג עסקה' || n === 'סוג' ? 1 : 0),
    voucher: n => (n.includes('שובר') || n.includes('אסמכתא') ? 1 : 0),
    card: n => (n.includes('כרטיס') || n.includes('4 ספרות') || n.includes('ספרות אחרונות') ? 1 : 0),
    notes: n => (n === 'הערות' || n.includes('פירוט נוסף') || n === 'פירוט' ? 1 : 0)
};

// מזהה אם השורה היא שורת כותרות; מחזיר מיפוי שדה -> אינדקס עמודה, או null
function detectHeader(row) {
    if (!Array.isArray(row)) return null;
    const mapping = {};
    const best = {};
    row.forEach((cell, index) => {
        if (cell === null || cell === undefined || typeof cell === 'number') return;
        const n = norm(cell);
        if (!n || n.length > 40) return;
        for (const [field, rule] of Object.entries(COLUMN_RULES)) {
            const score = rule(n);
            if (score > 0 && score > (best[field] || 0)) { best[field] = score; mapping[field] = index; }
        }
    });
    if (mapping.date === undefined || mapping.merchant === undefined) return null;
    if (mapping.charge === undefined && mapping.amount === undefined) return null;
    return mapping;
}

function guessIssuer(mapping) {
    if (mapping.category !== undefined && mapping.type !== undefined) return 'כאל';
    if (mapping.voucher !== undefined || mapping.notes !== undefined) return 'ישראכרט / אמקס';
    return 'כרטיס אשראי';
}

// ---------------------------------------------------------------- values

function parseDateCell(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return null; // מספר בלי עיצוב תאריך אינו תאריך
    const text = String(value).replace(/[‎‏]/g, '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (m) return isValidDateStr(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : null;
    m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?!\d)/.exec(text);
    if (!m) return null;
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    const iso = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return isValidDateStr(iso) ? iso : null;
}

function parseAmountCell(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = String(value).replace(/[‎‏‪-‮ \s₪$€£]/g, '').replace(/−/g, '-');
    if (!text) return null;
    let negative = false;
    if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
    if (text.endsWith('-')) { negative = true; text = text.slice(0, -1); }
    if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
    text = text.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(text)) return null;
    const n = Number(text);
    return negative ? -n : n;
}

function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[‎‏‪-‮]/g, '').replace(/\s+/g, ' ').trim();
}

function parseInstallment(...texts) {
    for (const text of texts) {
        const m = /תשלום\s*(\d+)\s*(?:מתוך|מ-?|\/)\s*(\d+)/.exec(cleanText(text));
        if (m && Number(m[2]) > 1 && Number(m[1]) <= Number(m[2])) return { n: Number(m[1]), of: Number(m[2]) };
    }
    return null;
}

function parseDataRow(row, mapping) {
    const cell = field => (mapping[field] === undefined ? undefined : row[mapping[field]]);
    const date = parseDateCell(cell('date'));
    const merchant = cleanText(cell('merchant'));
    if (!date || !merchant) return null;
    const charge = parseAmountCell(cell('charge'));
    const original = parseAmountCell(cell('amount'));
    let amount = charge !== null ? charge : original;
    if (amount === null) return null;
    const type = cleanText(cell('type'));
    const notes = cleanText(cell('notes'));
    if (/זיכוי|ביטול/.test(type) && amount > 0) amount = -amount;
    return {
        date,
        merchant,
        amount: Math.round(amount * 100) / 100,
        originalAmount: original !== null && charge !== null && original !== charge ? original : null,
        currency: cleanText(cell('currency')) || null,
        fileCategory: cleanText(cell('category')) || null,
        type: type || null,
        voucher: cleanText(cell('voucher')) || null,
        card: cleanText(cell('card')) || null,
        notes: notes || null,
        installment: parseInstallment(type, notes, cell('merchant'))
    };
}

// ---------------------------------------------------------------- main

function headerSignature(row) {
    return crypto.createHash('sha1').update((row || []).map(norm).join('|')).digest('hex').slice(0, 16);
}

/**
 * מפענח את הקובץ לרשימת עסקאות.
 * @param {Array<{name:string, rows:Array}>} sheets
 * @param {{[signature:string]: object}} savedMappings מיפויים ידניים ששמרנו בעבר, לפי חתימת שורת הכותרות
 * @returns {{ok:true, issuer:string, rows:Array, skipped:number} | {ok:false, needsMapping:true, signature:string, headerRowIndex:number, sample:Array}}
 */
function parseCardFile(sheets, savedMappings = {}) {
    const rows = [];
    let skipped = 0;
    let issuer = null;
    let sawHeader = false;

    for (const sheet of sheets) {
        let mapping = null;
        for (const row of sheet.rows) {
            const header = detectHeader(row);
            if (header) {
                mapping = header; sawHeader = true; issuer = issuer || guessIssuer(header);
                continue;
            }
            const saved = !mapping && savedMappings[headerSignature(row)];
            if (saved) { mapping = saved; sawHeader = true; issuer = issuer || 'כרטיס אשראי'; continue; }
            if (!mapping) continue;
            const parsed = parseDataRow(row, mapping);
            if (parsed) rows.push(parsed);
            else if (row.some(c => c !== null && c !== undefined && String(c).trim() !== '')) skipped += 1;
        }
    }

    if (!sawHeader) {
        const first = sheets.find(s => s.rows.length) || { rows: [] };
        const headerRowIndex = Math.max(0, first.rows.findIndex(r => r.filter(c => c !== null && c !== undefined && String(c).trim() !== '').length >= 3));
        return {
            ok: false,
            needsMapping: true,
            signature: headerSignature(first.rows[headerRowIndex]),
            headerRowIndex,
            sample: first.rows.slice(0, 25).map(r => r.map(c => (c === null || c === undefined ? '' : String(c))))
        };
    }
    return { ok: true, issuer: issuer || 'כרטיס אשראי', rows, skipped };
}

// מיפוי ידני שהמשתמש בחר: { date, merchant, amount, charge?, ... } -> אינדקסי עמודות
function parseWithManualMapping(sheets, headerRowIndex, mapping) {
    const rows = [];
    let skipped = 0;
    const sheet = sheets.find(s => s.rows.length) || { rows: [] };
    for (const row of sheet.rows.slice(headerRowIndex + 1)) {
        const parsed = parseDataRow(row, mapping);
        if (parsed) rows.push(parsed);
        else if (row.some(c => c !== null && c !== undefined && String(c).trim() !== '')) skipped += 1;
    }
    return { ok: true, issuer: 'כרטיס אשראי', rows, skipped };
}

// מפתח ייחודי לכל עסקה, כדי שהעלאה חוזרת של אותו קובץ (או קובץ חופף) לא תכפיל הוצאות.
// עסקאות זהות לגמרי באותו קובץ (שתי קניות זהות באותו יום) מקבלות מספר סידורי.
function assignKeys(rows) {
    const seen = new Map();
    return rows.map(row => {
        const base = [
            row.date, row.merchant.toLowerCase(), row.amount.toFixed(2), row.voucher || '', row.card || '',
            row.installment ? `${row.installment.n}/${row.installment.of}` : ''
        ].join('|');
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return { ...row, key: `cc:${crypto.createHash('sha1').update(base).digest('hex').slice(0, 20)}#${count}` };
    });
}

function normalizeMerchant(name) {
    return cleanText(name).toLowerCase();
}

module.exports = {
    readTabularFile, readXlsx, readCsv, parseCardFile, parseWithManualMapping, assignKeys,
    detectHeader, headerSignature, parseDateCell, parseAmountCell, parseInstallment, normalizeMerchant, norm
};
