'use strict';

// בדיקות מול בסיס נתונים אמיתי (SQLite) בתיקייה זמנית; לא נוגע בנתוני האתר.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
process.env.DATA_DIR = dataDir;
process.env.TZ_NAME = 'Asia/Jerusalem';

const db = require('../db');

async function waitForSchema() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await db.getExpenses();
            await db.getBudgets();
            await db.getTripExpenses();
            await db.getTripSummary();
            return;
        } catch (err) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    }
    throw new Error('database schema was not created in time');
}

async function run() {
    await waitForSchema();
    const today = db.todayStr();

    // בלי תאריך: נרשם היום
    await db.addExpense('בדיקה', 'סופר', 100, 'ללא תאריך', 'raw');
    await db.addExpense('בדיקה', 'סופר', 110, 'תאריך ריק', 'raw', null);

    // עם תאריך: נרשם בתאריך שנבחר, גם בחודש קודם
    await db.addExpense('בדיקה', 'סופר', 200, 'מספטמבר', 'raw', '2026-09-03');
    await db.addExpense('בדיקה', 'דלק', 50, 'מספטמבר', 'raw', '2026-09-20');

    const expenses = await db.getExpenses();
    const byDescription = description => expenses.find(e => e.description === description);
    assert.equal(byDescription('ללא תאריך').date, today);
    assert.equal(byDescription('תאריך ריק').date, today);
    assert.equal(expenses.filter(e => e.description === 'מספטמבר').map(e => e.date).sort().join(','), '2026-09-03,2026-09-20');

    // הרשימה ממוינת לפי תאריך ההוצאה (לא לפי סדר ההקלדה); באותו יום, האחרונה שהוקלדה ראשונה
    assert.deepEqual(
        expenses.map(e => `${e.date} ${e.description}`),
        [`${today} תאריך ריק`, `${today} ללא תאריך`, '2026-09-20 מספטמבר', '2026-09-03 מספטמבר'],
        'expenses are listed by expense date, newest first'
    );

    // תאריך לא תקין נדחה ולא נשמר
    const before = (await db.getExpenses()).length;
    await assert.rejects(() => db.addExpense('בדיקה', 'סופר', 1, 'x', 'raw', '2026-02-30'), /תאריך לא תקין/);
    await assert.rejects(() => db.addExpense('בדיקה', 'סופר', 1, 'x', 'raw', 'yesterday'), /תאריך לא תקין/);
    assert.equal((await db.getExpenses()).length, before, 'rejected expenses must not be stored');

    // הסיכום החודשי מתחשב בתאריך ההוצאה, לא בתאריך ההזנה
    const september = await db.getMonthSummary('2026-09');
    assert.equal(september.totalSpent, 250);
    assert.equal(september.expenseCount, 2);

    // מצב תקציב לפי חודש
    await db.setBudget('סופר', 1000);
    const septemberGrocery = await db.getCategoryRemaining('סופר', '2026-09');
    assert.deepEqual(
        [septemberGrocery.limit, septemberGrocery.spent, septemberGrocery.remaining],
        [1000, 200, 800]
    );
    const currentGrocery = await db.getCategoryRemaining('סופר');
    assert.equal(currentGrocery.spent, 210, 'default month is the current month (100 + 110)');

    // הוצאות טיול
    await db.addTripExpense('מלונות', 700, 'עם תאריך', '2026-10-01');
    await db.addTripExpense('מלונות', 300, 'בלי תאריך');
    const trip = await db.getTripExpenses();
    assert.equal(trip.find(e => e.description === 'עם תאריך').date, '2026-10-01');
    assert.equal(trip.find(e => e.description === 'בלי תאריך').date, today);
    await assert.rejects(() => db.addTripExpense('מלונות', 1, 'x', '2026-13-01'), /תאריך לא תקין/);

    console.log('DB expense date tests passed');
}

run()
    .catch(err => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });
