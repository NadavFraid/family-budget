const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, 'data', 'budget.db');

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
});

function addExpense(sender, category, amount, description, raw_text = '') {
    return new Promise((resolve, reject) => {
        const date = new Date().toISOString().slice(0, 10);
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
        db.all(`SELECT * FROM expenses ORDER BY id DESC LIMIT 100`, [], (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function getMonthlyStats() {
    return new Promise((resolve, reject) => {
        const currentMonth = new Date().toISOString().slice(0, 7);
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

function getCategoryRemaining(category) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentMonth = new Date().toISOString().slice(0, 7);
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
        const today = new Date();
        const dayOfMonth = today.getDate();
        const dateStr = today.toISOString().slice(0, 10);
        const monthStr = today.toISOString().slice(0, 7);

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

module.exports = {
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
    processDueRecurringExpenses
};
