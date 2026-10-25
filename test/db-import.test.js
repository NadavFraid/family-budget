'use strict';

// בדיקות מול SQLite אמיתי בתיקייה זמנית; לא נוגע בנתוני האתר.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-import-test-'));
process.env.TZ_NAME = 'Asia/Jerusalem';

const db = require('../db');
const item = (over = {}) => ({ key: 'cc:a#1', date: '2026-10-03', amount: 100, category: 'אוכל', description: 'שופרסל', merchant: 'שופרסל', learn: false, ...over });

async function waitForSchema() {
    for (let i = 0; i < 50; i += 1) {
        try { await db.getMerchantCategories(); await db.getExistingExternalIds(['x']); return; } catch (e) { await new Promise(r => setTimeout(r, 20)); }
    }
    throw new Error('import tables were not created in time');
}

async function run() {
    await waitForSchema();
    let r = await db.importCardExpenses([item(), item({ key: 'cc:b#1', amount: 50, learn: true, merchant: 'קפה', category: 'מסעדות' })]);
    assert.deepEqual(r, { inserted: 2, duplicates: 0 });

    // העלאה חוזרת לא מכפילה
    r = await db.importCardExpenses([item(), item({ key: 'cc:c#1', amount: -20 })]);
    assert.deepEqual(r, { inserted: 1, duplicates: 1 });
    assert.equal((await db.getExpenses({})).length, 3);

    const existing = await db.getExistingExternalIds(['cc:a#1', 'cc:zzz#1']);
    assert.deepEqual([...existing], ['cc:a#1']);

    assert.deepEqual(await db.getMerchantCategories(), { 'קפה': 'מסעדות' });

    // הוצאה ידנית (בלי external_id) נתפסת כהתאמה אפשרית רק בטווח הימים והסכום
    await db.addExpense('ווטסאפ', 'אוכל', 100, 'ידני', '', '2026-10-05');
    await db.addExpense('ווטסאפ', 'אוכל', 100, 'רחוק', '', '2026-10-20');
    const matches = await db.findManualMatches('2026-10-03', 100);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].description, 'ידני');

    await db.saveImportMapping('sig', { date: 0, merchant: 1, amount: 2 });
    assert.deepEqual(await db.getImportMappings(), { sig: { date: 0, merchant: 1, amount: 2 } });
    console.log('db-import tests passed');
}

run().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
