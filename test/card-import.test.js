'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const ci = require('../card-import');

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
    return (crc ^ 0xffffffff) >>> 0;
}

// בונה xlsx מינימלי בזיכרון (zip עם דחיסה) כדי לבדוק את הקורא בלי תלויות
function buildXlsx(rows, dateCols = [], prefix = '') {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const sheetRows = rows.map((r, i) => `<row r="${i + 1}">` + r.map((v, j) => {
        const ref = String.fromCharCode(65 + j) + (i + 1);
        if (v === null) return '';
        if (typeof v === 'number') return `<c r="${ref}"${dateCols.includes(j) ? ' s="1"' : ''}><v>${v}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    }).join('') + '</row>').join('');
    const files = {
        'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`
    };
    const parts = []; const central = []; let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const xml = prefix ? text.replace(/<(\/?)(?=[A-Za-z])/g, `<$1${prefix}:`) : text;
        const data = Buffer.from(xml); const comp = zlib.deflateRawSync(data); const nm = Buffer.from(name);
        const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc32(data), 14);
        h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
        parts.push(h, nm, comp);
        const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(data), 16);
        c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offset, 42);
        central.push(c, nm);
        offset += 30 + nm.length + comp.length;
    }
    const cd = Buffer.concat(central);
    const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt16LE(Object.keys(files).length, 8);
    e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, e]);
}

const HEAD = ['תאריך רכישה', 'שם בית עסק', 'סכום עסקה', 'סכום חיוב', 'מספר שובר', 'פירוט נוסף'];

test('xlsx ישראכרט: תאריכי אקסל, תשלומים וזיכוי', () => {
    const buf = buildXlsx([['פירוט'], HEAD, [46298, 'שופרסל', 250.5, 250.5, '1', null], [46300, 'מקס', 1200, 400, '2', 'תשלום 2 מתוך 3'], ['07/10/2026', 'החזר', -80, -80, '3', null]], [0]);
    const r = ci.parseCardFile(ci.readTabularFile(buf, 'a.xlsx'));
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 3);
    assert.equal(r.rows[0].date, '2026-10-03');
    assert.equal(r.rows[1].amount, 400);
    assert.deepEqual(r.rows[1].installment, { n: 2, of: 3 });
    assert.equal(r.rows[2].amount, -80);
    assert.equal(r.rows[2].date, '2026-10-07');
});

test('csv בקידוד windows-1255 וכאל: סוג עסקה וזיכוי', () => {
    const csv = 'תאריך עסקה,שם בית עסק,קטגוריה,סכום חיוב,סוג עסקה\n03/10/2026,"קפה, גן",מסעדות,"1,234.50",רגילה\n04/10/2026,ביטול,שונות,30,זיכוי\n';
    const r = ci.parseCardFile(ci.readTabularFile(Buffer.from(csv, 'utf8'), 'c.csv'));
    assert.equal(r.rows[0].amount, 1234.5);
    assert.equal(r.rows[0].merchant, 'קפה, גן');
    assert.equal(r.rows[0].fileCategory, 'מסעדות');
    assert.equal(r.rows[1].amount, -30);
});

test('כותרות לא מזוהות מבקשות מיפוי ידני', () => {
    const r = ci.parseCardFile([{ name: 'x', rows: [['a', 'b', 'c'], ['1', '2', '3']] }]);
    assert.equal(r.ok, false);
    assert.equal(r.needsMapping, true);
    const m = ci.parseWithManualMapping([{ name: 'x', rows: [['a', 'b', 'c'], ['03/10/2026', 'חנות', '15']] }], 0, { date: 0, merchant: 1, amount: 2 });
    assert.equal(m.rows[0].amount, 15);
});

test('מפתחות ייחודיים: זהים באותו קובץ מקבלים מספר סידורי ויציבים בין הרצות', () => {
    const row = { date: '2026-10-03', merchant: 'x', amount: 10, voucher: null, card: null, installment: null };
    const a = ci.assignKeys([row, { ...row }]);
    const b = ci.assignKeys([row, { ...row }]);
    assert.notEqual(a[0].key, a[1].key);
    assert.deepEqual(a.map(x => x.key), b.map(x => x.key));
});

test('parseAmountCell ו-parseDateCell', () => {
    assert.equal(ci.parseAmountCell('(12.5)'), -12.5);
    assert.equal(ci.parseAmountCell('₪ 1,000'), 1000);
    assert.equal(ci.parseAmountCell('abc'), null);
    assert.equal(ci.parseDateCell('31/02/2026'), null);
    assert.equal(ci.parseDateCell('1.2.26'), '2026-02-01');
});

test('קובץ xls ישן וקובץ ריק נדחים', () => {
    assert.throws(() => ci.readTabularFile(Buffer.alloc(0)));
    assert.throws(() => ci.readTabularFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0])), /xls/);
});

test('מתחיל אחרי "עסקאות למועד חיוב", מדלג על "שטרם נקלטו" ועוצר בשורת הסיכום (גם עם קידומת x: ב-xml)', () => {
    const head = ['תאריך רכישה', 'שם בית עסק', 'סכום עסקה', 'מטבע עסקה', 'סכום חיוב', 'מטבע חיוב', "מס' שובר", 'פירוט נוסף'];
    const rows = [
        ['פירוט עסקאות', null, 'דצמבר 2026'],
        ['עסקאות שטרם נקלטו'],
        ['תאריך רכישה', 'שם בית עסק', 'סכום עסקה', 'מטבע עסקה'],
        ['15.11.26', 'עוד לא חויב', 280.23, '₪'],
        [null, 'סה"כ עסקאות שטרם נקלטו', 280.23, '₪'],
        ['עסקאות למועד חיוב'],
        head,
        ['13.11.26', 'סניף יג', 32.8, '₪', 32.8, '₪', '501', ''],
        ['11.11.26', 'אתר חו"ל', 53.79, '£', 229.89, '₪', '502', 'אתר חו"ל'],
        ['06.10.26', 'ביטוח', 634, '₪', 126.6, '₪', '503', 'תשלום 2 מתוך 5'],
        [null, 'סה"כ לחיוב החודש בכרטיס בש"ח', null, null, 389.29, '₪'],
        ['אחרי הסיכום', 'שורה שלא צריכה להיקרא', 5, '₪', 5, '₪']
    ];
    for (const prefix of ['', 'x']) {
        const r = ci.parseCardFile(ci.readTabularFile(buildXlsx(rows, [], prefix), 'a.xlsx'));
        assert.equal(r.ok, true);
        assert.deepEqual(r.rows.map(x => x.amount), [32.8, 229.89, 126.6]);
        assert.equal(r.rows[1].originalAmount, 53.79);
        assert.deepEqual(r.rows[2].installment, { n: 2, of: 5 });
    }
});

test('זיהוי תאריך חיוב מ"לחיוב ב-02.12" והשלמת השנה אחרי העסקה האחרונה', () => {
    const head = ['תאריך רכישה', 'שם בית עסק', 'סכום עסקה', 'מטבע עסקה', 'סכום חיוב', 'מטבע חיוב', "מס' שובר", 'פירוט נוסף'];
    const mk = (d, date) => ci.parseCardFile([{ name: 'x', rows: [['על שם', null, null, null, null, null, null, d], ['עסקאות למועד חיוב'], head, [date, 'חנות', 10, '₪', 10, '₪', '1', '']] }]);
    assert.equal(mk('לחיוב ב-02.12', '13.11.26').chargeDate, '2026-12-02');
    assert.equal(mk('לחיוב ב-02.01', '28.12.26').chargeDate, '2027-01-02');
    assert.equal(mk('אין', '13.11.26').chargeDate, null);
});
