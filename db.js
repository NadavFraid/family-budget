const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'budget.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        category TEXT,
        amount REAL,
        description TEXT,
        raw_text TEXT,
        date DATETIME
    )`);

    db.run(`ALTER TABLE expenses ADD COLUMN raw_text TEXT`, () => {});
    db.run(`ALTER TABLE expenses ADD COLUMN date DATETIME`, () => {
        db.run(`UPDATE expenses SET date = datetime('now', '+3 hours') WHERE date IS NULL`, () => {});
    });

    db.run(`CREATE TABLE IF NOT EXISTS budgets (
        category TEXT PRIMARY KEY,
        monthly_limit REAL
    )`);

    // טבלת תשלומים קבועים / הוראות קבע
    db.run(`CREATE TABLE IF NOT EXISTS recurring_expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        category TEXT,
        amount REAL,
        day_of_month INTEGER,
        description TEXT
    )`);

    // טבלת מעקב למניעת כפילויות חיוב באותו חודש
    db.run(`CREATE TABLE IF NOT EXISTS recurring_logs (
        recurring_id INTEGER,
        month_year TEXT,
        PRIMARY KEY (recurring_id, month_year)
    )`);
});

function addExpense(sender, category, amount, description, rawText) {
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO expenses (sender, category, amount, description, raw_text, date) VALUES (?, ?, ?, ?, ?, datetime('now', '+3 hours'))`;
        db.run(query, [sender, category, amount, description, rawText], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
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

function getExpenses() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT id, sender, category, amount, description, raw_text, COALESCE(date, datetime('now', '+3 hours')) as date FROM expenses ORDER BY date DESC LIMIT 100`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getMonthlyStats() {
    return new Promise((resolve, reject) => {
        const query = `
            SELECT category, SUM(amount) as total 
            FROM expenses 
            WHERE strftime('%Y-%m', COALESCE(date, datetime('now', '+3 hours'))) = strftime('%Y-%m', 'now', '+3 hours')
            GROUP BY category
        `;
        db.all(query, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getBudgets() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM budgets`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function setBudget(category, monthly_limit) {
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?) 
                       ON CONFLICT(category) DO UPDATE SET monthly_limit = ?`;
        db.run(query, [category, monthly_limit, monthly_limit], function(err) {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

function getCategoryRemaining(category) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT monthly_limit FROM budgets WHERE category = ?`, [category], (err, budgetRow) => {
            if (err) return reject(err);
            const limit = budgetRow ? budgetRow.monthly_limit : 0;

            const query = `
                SELECT SUM(amount) as spent 
                FROM expenses 
                WHERE category = ? AND strftime('%Y-%m', COALESCE(date, datetime('now', '+3 hours'))) = strftime('%Y-%m', 'now', '+3 hours')
            `;
            db.get(query, [category], (err, expenseRow) => {
                if (err) return reject(err);
                const spent = expenseRow && expenseRow.spent ? expenseRow.spent : 0;
                const remaining = limit > 0 ? limit - spent : null;
                resolve({ limit, spent, remaining });
            });
        });
    });
}

// פונקציות לניהול הוראות קבע
function addRecurringExpense(title, category, amount, day_of_month, description) {
    return new Promise((resolve, reject) => {
        const query = `INSERT INTO recurring_expenses (title, category, amount, day_of_month, description) VALUES (?, ?, ?, ?, ?)`;
        db.run(query, [title, category, amount, day_of_month, description], function(err) {
            if (err) reject(err);
            else resolve(this.lastID);
        });
    });
}

function getRecurringExpenses() {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM recurring_expenses ORDER BY day_of_month ASC`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function deleteRecurringExpense(id) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM recurring_expenses WHERE id = ?`, [id], (err) => {
            if (err) reject(err);
            else resolve(true);
        });
    });
}

function processDueRecurringExpenses() {
    return new Promise((resolve, reject) => {
        const today = new Date();
        const currentDay = today.getDate();
        const monthYear = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;

        db.all(`SELECT * FROM recurring_expenses WHERE day_of_month = ?`, [currentDay], async (err, rows) => {
            if (err) return reject(err);
            const processed = [];

            for (const item of rows) {
                const checkQuery = `SELECT * FROM recurring_logs WHERE recurring_id = ? AND month_year = ?`;
                const alreadyRun = await new Promise(res => db.get(checkQuery, [item.id, monthYear], (e, r) => res(!!r)));

                if (!alreadyRun) {
                    await addExpense('הוראת קבע', item.category, item.amount, `${item.title} (הוראת קבע)`, `תשלום אוטומטי - ${item.title}`);
                    await new Promise(res => db.run(`INSERT INTO recurring_logs (recurring_id, month_year) VALUES (?, ?)`, [item.id, monthYear], () => res()));
                    processed.push(item);
                }
            }
            resolve(processed);
        });
    });
}

module.exports = { 
    addExpense, deleteLastExpense, getExpenses, getMonthlyStats, 
    getBudgets, setBudget, getCategoryRemaining,
    addRecurringExpense, getRecurringExpenses, deleteRecurringExpense, processDueRecurringExpenses 
};
