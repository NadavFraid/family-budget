'use strict';

// בדיקות מול SQLite אמיתי בתיקייה זמנית; לא נוגע בנתוני האתר.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-loans-test-'));
process.env.DATA_DIR = dataDir;
process.env.TZ_NAME = 'Asia/Jerusalem';

const db = require('../db');
const loan = (over = {}) => ({ lender: 'בנק', principal: 1000, start_date: null, total_payments: 3, paid_payments: 0, monthly_payment: null, notes: '', ...over });

async function waitForSchema() {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try { await db.getLoans(); return; } catch (err) { await new Promise(r => setTimeout(r, 20)); }
    }
    throw new Error('loans table was not created in time');
}

async function run() {
    await waitForSchema();
    assert.deepEqual(await db.getLoans(), []);

    const a = await db.addLoan(loan({ lender: 'ישנה', start_date: '2026-01-01', monthly_payment: 350.5, notes: 'הערה "מיוחדת" <b>' }));
    const b = await db.addLoan(loan({ lender: 'חדשה', start_date: '2026-06-01', total_payments: 12, paid_payments: 2 }));
    const c = await db.addLoan(loan({ lender: 'סגורה', start_date: '2026-09-01', total_payments: 2, paid_payments: 2 }));
    const d = await db.addLoan(loan({ lender: 'בלי תאריך' }));

    let all = await db.getLoans();
    assert.equal(all.length, 4);
    assert.equal(all.find(l => l.id === a).notes, 'הערה "מיוחדת" <b>', 'notes are stored verbatim');
    assert.equal(all.find(l => l.id === a).monthly_payment, 350.5);
    assert.equal(all.find(l => l.id === b).monthly_payment, null);
    assert.equal(all[all.length - 1].id, c, 'a fully paid loan sorts last');
    const active = all.slice(0, -1).map(l => l.id);
    assert.deepEqual(active, [d, b, a], 'active loans: newest first (a loan without a start date counts from the day it was added)');

    // סימון תשלום וביטולו
    let r = await db.adjustLoanPayment(a, 1);
    assert.equal(r.changed, true);
    assert.equal(r.loan.paid_payments, 1);
    r = await db.adjustLoanPayment(a, -1);
    assert.equal(r.loan.paid_payments, 0);

    // גבולות: לא מתחת ל-0 ולא מעל הסך הכולל
    r = await db.adjustLoanPayment(a, -1);
    assert.equal(r.changed, false);
    assert.equal(r.loan.paid_payments, 0, 'cannot go below zero');
    r = await db.adjustLoanPayment(c, 1);
    assert.equal(r.changed, false);
    assert.equal(r.loan.paid_payments, 2, 'cannot exceed the total');

    // לחיצות מקבילות לא עוברות את הסך הכולל
    await Promise.all(Array.from({ length: 10 }, () => db.adjustLoanPayment(a, 1)));
    assert.equal((await db.getLoans()).find(l => l.id === a).paid_payments, 3, 'ten parallel clicks stop at the total (3)');

    r = await db.adjustLoanPayment(999999, 1);
    assert.equal(r.loan, null, 'unknown id');

    // עריכה
    assert.equal(await db.updateLoan(b, loan({ lender: 'עודכנה', principal: 2222.5, total_payments: 24, paid_payments: 5, monthly_payment: 100, notes: 'חדש', start_date: '2026-07-07' })), true);
    all = await db.getLoans();
    assert.deepEqual({ ...all.find(l => l.id === b) },
        { id: b, lender: 'עודכנה', principal: 2222.5, start_date: '2026-07-07', total_payments: 24, paid_payments: 5, monthly_payment: 100, notes: 'חדש' });
    assert.equal(await db.updateLoan(999999, loan()), false, 'unknown id is not updated');

    // מחיקה
    assert.equal(await db.deleteLoan(d), true);
    assert.equal(await db.deleteLoan(d), false);
    assert.equal((await db.getLoans()).length, 3);

    // הלוואות נכנסות לגיבוי (הגיבוי הוא עותק של כל המסד)
    const snap = path.join(dataDir, 'snap.db');
    await db.snapshotTo(snap);
    assert.ok(fs.statSync(snap).size > 0, 'snapshot created');

    console.log('DB loans tests passed');
}

run()
    .catch(err => { console.error(err); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
