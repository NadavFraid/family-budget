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

    db.run(`CREATE TABLE IF NOT EXISTS trip_settings (
        key TEXT PRIMARY KEY,
        value REAL
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

function deleteExpense(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM expenses WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}

function getExpenses() {
    return new Promise((resolve, reject) => {
        // לפי תאריך ההוצאה (לא סדר ההקלדה), כדי שהוצאות שהוזנו בדיעבד יופיעו במקום הנכון
        db.all(`SELECT * FROM expenses ORDER BY date DESC, id DESC LIMIT 100`, [], (err, rows) => {
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

module.exports = {
    todayStr,
    currentMonthStr,
    getAvailableMonths,
    getMonthSummary,
    deleteBudget,
    updateExpenseCategory,
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


function deleteBudget(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM budgets WHERE id = ?`, [id], function(err) {
            if (err) reject(err);
            else resolve(this.changes > 0);
        });
    });
}
