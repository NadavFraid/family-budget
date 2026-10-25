const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { isValidDateStr } = require('./expense-date-parser');
// ניתן להחליף את תיקיית הנתונים במשתנה סביבה (שימושי לבדיקות ול-Docker volume).
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
const dbPath = path.join(dataDir, 'budget.db');

fs.mkdirSync(dataDir, { recursive: true });

// תאריכים וחודשים מחושבים לפי אזור הזמן של המשפחה (ברירת מחדל: ישראל),
// ולא לפי UTC, כדי שהוצאה מאוחר בלילה לא תירשם ליום או לחודש הקודם.
const TZ_NAME = process.env.TZ_NAME || 'Asia/Jerusalem';
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_NAME, year: 'numeric', month: '2-digit', day: '2-digit'
});

function todayStr() {
    return dateFormatter.format(new Date()); // YYYY-MM-DD
}

function currentMonthStr() {
    return todayStr().slice(0, 7); // YYYY-MM
}

// תאריך הוצאה אופציונלי: בלי תאריך נרשם היום; תאריך לא תקין נדחה ולא נשמר בשקט.
function normalizeExpenseDate(date) {
    if (date === undefined || date === null || date === '') return todayStr();
    if (!isValidDateStr(date)) throw new Error(`תאריך לא תקין: ${date}`);
    return date;
}

const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        sender TEXT,
        category TEXT,
        amount REAL,
        description TEXT,
        raw_text TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS budgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT UNIQUE,
        monthly_limit REAL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS recurring_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        category TEXT,
        amount REAL,
        day_of_month INTEGER,
        description TEXT,
        last_processed TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trip_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        category TEXT,
        amount REAL,
        description TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lender TEXT NOT NULL,
        principal REAL NOT NULL,
        start_date TEXT,
        total_payments INTEGER NOT NULL,
        paid_payments INTEGER NOT NULL DEFAULT 0,
        monthly_payment REAL,
        notes TEXT DEFAULT '',
        created_at TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS trip_settings (
        key TEXT PRIMARY KEY,
        value REAL
    )`);

    // ---- ייבוא מכרטיסי אשראי ----
    // העמודה נוספת למסדים קיימים; אם כבר קיימת השגיאה מתעלמת
    db.run(`ALTER TABLE expenses ADD COLUMN external_id TEXT`, () => {});
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_external_id ON expenses(external_id) WHERE external_id IS NOT NULL`);
    db.run(`CREATE TABLE IF NOT EXISTS merchant_categories (
        merchant TEXT PRIMARY KEY,
        category TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS import_mappings (
        signature TEXT PRIMARY KEY,
        mapping TEXT NOT NULL
    )`);
});

function addExpense(sender, category, amount, description, raw_text = '', expenseDate = null) {
    return new Promise((resolve, reject) => {
        let date;
        try { date = normalizeExpenseDate(expenseDate); } catch (e) { return reject(e); }
        db.run(
            `INSERT INTO expenses (date, sender, category, amount, description, raw_text) VALUES (?, ?, ?, ?, ?, ?)`,
            [date, sender, category, amount, description, raw_text],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function deleteLastExpense() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM expenses ORDER BY id DESC LIMIT 1`, [], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            db.run(`DELETE FROM expenses WHERE id = ?`, [row.id], (err2) => {
                if (err2) reject(err2);
                else resolve(row);
            });
        });
    });
}

// עותק עקבי של מסד הנתונים לקובץ חדש (VACUUM INTO), גם בזמן שהאתר כותב אליו.
// העתקת קובץ ה-db הפעיל ישירות עלולה לתפוס אותו באמצע כתיבה.
function snapshotTo(destPath) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(destPath)) return reject(new Error('קובץ היעד כבר קיים'));
        db.run('VACUUM INTO ?', [destPath], err => (err ? reject(err) : resolve(destPath)));
    });
}

function deleteExpense(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM expenses WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

// התווית שהאתר מציג להוצאות בלי קטגוריה (גם בעוגה), כדי שאפשר יהיה לסנן לפיה
const UNCATEGORIZED_LABEL = 'ללא קטגוריה';

// בלי פרמטרים: 100 ההוצאות האחרונות. עם category ו/או month (YYYY-MM): ההוצאות המתאימות (עד 500).
function getExpenses({ category = null, month = null } = {}) {
    return new Promise((resolve, reject) => {
        const where = [];
        const params = [];
        if (month) {
            where.push(`strftime('%Y-%m', date) = ?`);
            params.push(month);
        }
        if (category) {
            if (category === UNCATEGORIZED_LABEL) {
                where.push(`(category IS NULL OR TRIM(category) = '' OR category = ?)`);
                params.push(category);
            } else {
                where.push(`category = ?`);
                params.push(category);
            }
        }
        const limit = category || month ? 500 : 100;
        // לפי תאריך ההוצאה (לא סדר ההקלדה), כדי שהוצאות שהוזנו בדיעבד יופיעו במקום הנכון
        const sql = `SELECT * FROM expenses${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ${limit}`;
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getMonthlyStats() {
    return new Promise((resolve, reject) => {
        const currentMonth = currentMonthStr();
        db.all(
            `SELECT category, SUM(amount) as total FROM expenses WHERE strftime('%Y-%m', date) = ? GROUP BY category`,
            [currentMonth],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

function getBudgets() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM budgets`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function setBudget(category, monthly_limit) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`,
            [category, monthly_limit],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

// month (YYYY-MM) אופציונלי: ברירת המחדל היא החודש הנוכחי.
function getCategoryRemaining(category, month = currentMonthStr()) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentMonth = month;
            db.get(`SELECT monthly_limit FROM budgets WHERE category = ?`, [category], (err, bRow) => {
                if (err) return reject(err);
                const limit = bRow ? bRow.monthly_limit : 0;
                db.get(
                    `SELECT SUM(amount) as spent FROM expenses WHERE category = ? AND strftime('%Y-%m', date) = ?`,
                    [category, currentMonth],
                    (err2, sRow) => {
                        if (err2) return reject(err2);
                        const spent = (sRow && sRow.spent) ? sRow.spent : 0;
                        resolve({ limit, spent, remaining: limit - spent });
                    }
                );
            });
        } catch (e) {
            reject(e);
        }
    });
}

function addRecurringExpense(title, category, amount, day_of_month, description = '') {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO recurring_expenses (title, category, amount, day_of_month, description) VALUES (?, ?, ?, ?, ?)`,
            [title, category, amount, day_of_month, description],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getRecurringExpenses() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM recurring_expenses`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function deleteRecurringExpense(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM recurring_expenses WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

function processDueRecurringExpenses() {
    return new Promise((resolve, reject) => {
        const dateStr = todayStr();
        const dayOfMonth = parseInt(dateStr.slice(8, 10), 10);
        const monthStr = dateStr.slice(0, 7);

        db.all(`SELECT * FROM recurring_expenses WHERE day_of_month = ?`, [dayOfMonth], async (err, rows) => {
            if (err) return reject(err);
            const executed = [];
            for (const item of rows || []) {
                if (!item.last_processed || item.last_processed.slice(0, 7) !== monthStr) {
                    await addExpense('הוראת קבע', item.category, item.amount, item.title, `הוראת קבע אוטומטית: ${item.title}`);
                    db.run(`UPDATE recurring_expenses SET last_processed = ? WHERE id = ?`, [dateStr, item.id]);
                    executed.push(item);
                }
            }
            resolve(executed);
        });
    });
}

/* פונקציות לתקציב טיול */
function addTripExpense(category, amount, description, expenseDate = null) {
    return new Promise((resolve, reject) => {
        let date;
        try { date = normalizeExpenseDate(expenseDate); } catch (e) { return reject(e); }
        db.run(
            `INSERT INTO trip_expenses (date, category, amount, description) VALUES (?, ?, ?, ?)`,
            [date, category, amount, description],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getTripExpenses() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM trip_expenses ORDER BY id DESC`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function deleteTripExpense(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM trip_expenses WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

function setTripBudget(limitAmount) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO trip_settings (key, value) VALUES ('total_budget', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            [limitAmount],
            function(err) {
                if (err) reject(err);
                else resolve(true);
            }
        );
    });
}

function getTripSummary() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT value FROM trip_settings WHERE key = 'total_budget'`, [], (err, bRow) => {
            if (err) return reject(err);
            const limit = bRow ? bRow.value : 0;
            db.get(`SELECT SUM(amount) as spent FROM trip_expenses`, [], (err2, sRow) => {
                if (err2) return reject(err2);
                const spent = (sRow && sRow.spent) ? sRow.spent : 0;
                resolve({ limit, spent, remaining: limit - spent });
            });
        });
    });
}


function deleteLastTripExpense() {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM trip_expenses ORDER BY id DESC LIMIT 1`, [], (err, row) => {
            if (err) return reject(err);
            if (!row) return resolve(null);
            db.run(`DELETE FROM trip_expenses WHERE id = ?`, [row.id], (err2) => {
                if (err2) reject(err2);
                else resolve(row);
            });
        });
    });
}


function updateExpenseCategory(id, newCategory) {
return new Promise((resolve, reject) => {
    db.run(`UPDATE expenses SET category = ? WHERE id = ?`, [newCategory, id], function(err) {
        if (err) return reject(err);
        resolve({ id, category: newCategory, changes: this.changes });
    });
});
}

// עריכת כל שדות ההוצאה. השולח והטקסט המקורי של ההודעה נשארים כמו שהיו.
function updateExpense(id, { amount, category, description, date }) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE expenses SET amount = ?, category = ?, description = ?, date = ? WHERE id = ?`,
            [amount, category, description, date, id],
            function(err) {
                if (err) return reject(err);
                resolve({ id: Number(id), amount, category, description, date, changes: this.changes });
            }
        );
    });
}

function getAvailableMonths() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT DISTINCT strftime('%Y-%m', date) as month FROM expenses WHERE date IS NOT NULL ORDER BY month DESC`,
            [],
            (err, rows) => {
                if (err) return reject(err);
                const currentMonth = currentMonthStr();
                const months = (rows || []).map(r => r.month).filter(Boolean);
                if (!months.includes(currentMonth)) months.unshift(currentMonth);
                resolve(months.sort().reverse());
            }
        );
    });
}

function getMonthSummary(month) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM expenses WHERE strftime('%Y-%m', date) = ? ORDER BY date DESC, id DESC`,
            [month],
            (err, expenses) => {
                if (err) return reject(err);
                db.all(`SELECT * FROM budgets`, [], (err2, budgets) => {
                    if (err2) return reject(err2);
                    const spentByCategory = {};
                    let totalSpent = 0;
                    (expenses || []).forEach(ex => {
                        const cat = ex.category || 'ללא קטגוריה';
                        const amt = ex.amount || 0;
                        spentByCategory[cat] = (spentByCategory[cat] || 0) + amt;
                        totalSpent += amt;
                    });

                    const limits = {};
                    (budgets || []).forEach(b => { limits[b.category] = b.monthly_limit || 0; });

                    const allCategories = new Set([...Object.keys(limits), ...Object.keys(spentByCategory)]);
                    const categories = [...allCategories].map(category => {
                        const limit = limits[category] || 0;
                        const spent = spentByCategory[category] || 0;
                        return { category, limit, spent, remaining: limit - spent };
                    }).sort((a, b) => b.spent - a.spent);

                    const totalBudget = Object.values(limits).reduce((sum, v) => sum + v, 0);
                    resolve({
                        month,
                        totalSpent,
                        totalBudget,
                        remaining: totalBudget - totalSpent,
                        expenseCount: (expenses || []).length,
                        categories,
                        expenses: expenses || []
                    });
                });
            }
        );
    });
}

// ---- הלוואות ----
const LOAN_COLUMNS = 'id, lender, principal, start_date, total_payments, paid_payments, monthly_payment, notes';

// הלוואות פעילות קודם (הכי חדשה למעלה), ואחריהן הלוואות שנסגרו
function getLoans() {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT ${LOAN_COLUMNS} FROM loans
             ORDER BY (paid_payments >= total_payments) ASC, COALESCE(start_date, created_at) DESC, id DESC`,
            [],
            (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
    });
}

function addLoan(loan) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO loans (lender, principal, start_date, total_payments, paid_payments, monthly_payment, notes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [loan.lender, loan.principal, loan.start_date, loan.total_payments, loan.paid_payments, loan.monthly_payment, loan.notes, todayStr()],
            function(err) { return err ? reject(err) : resolve(this.lastID); }
        );
    });
}

function updateLoan(id, loan) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE loans SET lender = ?, principal = ?, start_date = ?, total_payments = ?, paid_payments = ?, monthly_payment = ?, notes = ?
             WHERE id = ?`,
            [loan.lender, loan.principal, loan.start_date, loan.total_payments, loan.paid_payments, loan.monthly_payment, loan.notes, id],
            function(err) { return err ? reject(err) : resolve(this.changes > 0); }
        );
    });
}

// מוסיף (delta=1) או מבטל (delta=-1) תשלום אחד; הגבולות 0..total נאכפים בתוך ה-UPDATE עצמו
// (לחיצה כפולה או שני מכשירים באותו רגע לא יכולים לעבור את הסך הכולל). מחזיר את ההלוואה המעודכנת או null.
function adjustLoanPayment(id, delta) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE loans SET paid_payments = paid_payments + ?
             WHERE id = ? AND paid_payments + ? >= 0 AND paid_payments + ? <= total_payments`,
            [delta, id, delta, delta],
            function(err) {
                if (err) return reject(err);
                const changed = this.changes > 0; // `this` ב-callback הפנימי הוא כבר לא ה-UPDATE
                db.get(`SELECT ${LOAN_COLUMNS} FROM loans WHERE id = ?`, [id], (err2, row) => {
                    if (err2) return reject(err2);
                    resolve({ loan: row || null, changed });
                });
            }
        );
    });
}

function deleteLoan(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM loans WHERE id = ?`, [id], function(err) { return err ? reject(err) : resolve(this.changes > 0); });
    });
}

module.exports = {
    getExistingExternalIds,
    findManualMatches,
    getMerchantCategories,
    getImportMappings,
    saveImportMapping,
    importCardExpenses,
    getLoans,
    addLoan,
    updateLoan,
    adjustLoanPayment,
    deleteLoan,
    UNCATEGORIZED_LABEL,
    snapshotTo,
    dataDir,
    todayStr,
    currentMonthStr,
    getAvailableMonths,
    getMonthSummary,
    deleteBudget,
    updateExpenseCategory,
    updateExpense,
    deleteLastTripExpense,
    addExpense,
    deleteLastExpense,
    deleteExpense,
    getExpenses,
    getMonthlyStats,
    getBudgets,
    setBudget,
    getCategoryRemaining,
    addRecurringExpense,
    getRecurringExpenses,
    deleteRecurringExpense,
    processDueRecurringExpenses,
    addTripExpense,
    getTripExpenses,
    deleteTripExpense,
    setTripBudget,
    getTripSummary
};

// ---- ייבוא מכרטיסי אשראי ----
function allP(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || []))));
}
function runP(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function(err) { return err ? reject(err) : resolve(this.changes); }));
}

// אילו מפתחות עסקה כבר יובאו בעבר
async function getExistingExternalIds(keys) {
    const found = new Set();
    for (let i = 0; i < keys.length; i += 500) {
        const chunk = keys.slice(i, i + 500);
        const rows = await allP(`SELECT external_id FROM expenses WHERE external_id IN (${chunk.map(() => '?').join(',')})`, chunk);
        rows.forEach(r => found.add(r.external_id));
    }
    return found;
}

// הוצאות שהוקלדו ידנית (ווטסאפ/טופס, בלי external_id) עם אותו סכום בטווח של ימים סביב התאריך
async function findManualMatches(date, amount, days = 3) {
    return allP(
        `SELECT id, date, category, amount, description FROM expenses
         WHERE external_id IS NULL AND ABS(amount - ?) < 0.005
           AND date BETWEEN date(?, ?) AND date(?, ?) ORDER BY date, id`,
        [amount, date, `-${days} days`, date, `+${days} days`]
    );
}

async function getMerchantCategories() {
    const map = {};
    (await allP(`SELECT merchant, category FROM merchant_categories`)).forEach(r => { map[r.merchant] = r.category; });
    return map;
}

async function getImportMappings() {
    const map = {};
    (await allP(`SELECT signature, mapping FROM import_mappings`)).forEach(r => {
        try { map[r.signature] = JSON.parse(r.mapping); } catch (e) { /* מיפוי פגום מתעלמים */ }
    });
    return map;
}

function saveImportMapping(signature, mapping) {
    return runP(`INSERT OR REPLACE INTO import_mappings (signature, mapping) VALUES (?, ?)`, [signature, JSON.stringify(mapping)]);
}

// items: [{key, date, amount, category, description, merchant, raw}]; כל הייבוא בטרנזקציה אחת
async function importCardExpenses(items, sender = 'ייבוא אשראי') {
    let inserted = 0;
    let duplicates = 0;
    await runP('BEGIN');
    try {
        for (const it of items) {
            const changes = await runP(
                `INSERT OR IGNORE INTO expenses (date, sender, category, amount, description, raw_text, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [it.date, sender, it.category, it.amount, it.description, it.raw || '', it.key]
            );
            if (changes) inserted += 1; else duplicates += 1;
            if (it.merchant && it.learn) {
                await runP(`INSERT OR REPLACE INTO merchant_categories (merchant, category) VALUES (?, ?)`, [it.merchant, it.category]);
            }
        }
        await runP('COMMIT');
    } catch (e) {
        await runP('ROLLBACK').catch(() => {});
        throw e;
    }
    return { inserted, duplicates };
}

function deleteBudget(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM budgets WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}
