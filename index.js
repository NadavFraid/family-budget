const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { createMessageHandler } = require('./whatsapp-message-handler');
const { 
    addExpense, deleteLastExpense, deleteExpense, getExpenses, getMonthlyStats, 
    getBudgets, setBudget, getCategoryRemaining,
    addRecurringExpense, getRecurringExpenses, deleteRecurringExpense, processDueRecurringExpenses,
    addTripExpense, deleteLastTripExpense, getTripExpenses, deleteTripExpense, setTripBudget, getTripSummary,
    getAvailableMonths, getMonthSummary, currentMonthStr
} = require('./db');

function removeSingletonLocks(dir) {
    if (!fs.existsSync(dir)) return;
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.lstatSync(fullPath);
                if (stat.isDirectory()) {
                    removeSingletonLocks(fullPath);
                } else if (file.startsWith('Singleton')) {
                    fs.unlinkSync(fullPath);
                }
            } catch (err) {
                try { fs.unlinkSync(fullPath); } catch (e) {}
            }
        }
    } catch (e) {}
}

removeSingletonLocks(path.join(__dirname, '.wwebjs_auth'));

const crypto = require('crypto');

// פרטי ההזדהות נקראים ממשתני סביבה בלבד (לא נשמרים בקוד).
const AUTH_USER = process.env.AUTH_USER || 'family';
const AUTH_PASS = process.env.AUTH_PASS || '';
// מפתח סודי לנתיב /api/quick-add (נשלח בכותרת x-api-key)
const QUICK_ADD_KEY = process.env.QUICK_ADD_KEY || '';
const TZ_NAME = process.env.TZ_NAME || 'Asia/Jerusalem';

if (!AUTH_PASS) {
    console.error('❌ חסר משתנה סביבה AUTH_PASS. הגדר סיסמה לאתר לפני הפעלת השרת.');
    process.exit(1);
}
if (!QUICK_ADD_KEY) {
    console.warn('⚠️ QUICK_ADD_KEY לא מוגדר - הנתיב /api/quick-add חסום עד שיוגדר מפתח.');
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

let TARGET_GROUP_ID = '';

const HOME_BUDGET_GROUPS = ['120363429815455473@g.us', 'תקציב משפחתי'];
const TRIP_BUDGET_GROUPS = ['120363411073949210@g.us', 'תקציב טיול'];

function cleanString(str) {
    return (str || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
}

const STORE_CATEGORY_MAP = [
    { category: 'סופר', keywords: ['שופרסל', 'אושר עד', 'רמי לוי', 'יוחננוף', 'טיב טעם', 'ויקטורי', 'מחסני השוק', 'קרפור', 'חצי חינם', 'ampm', 'am:pm', 'מגה', 'osher ad', 'shufersal', 'victory', 'carrefour', 'super'] },
    { category: 'דלק', keywords: ['פז', 'סונול', 'דלק', 'דור אלון', 'מנטה', 'אלונית', 'yellow', 'paz', 'sonol', 'delek', 'ten', 'תן'] },
    { category: 'פארם', keywords: ['סופר פארם', 'סופר-פארם', 'סופרפארם', 'be', 'בי', 'super-pharm', 'super pharm', 'pharm'] },
    { category: 'מסעדות', keywords: ['מקדונלדס', 'ארומה', 'גולדה', 'פיצה', 'בורגר', 'mcdonalds', 'aroma', 'golda', 'cafe', 'קפה'] },
    { category: 'תחבורה', keywords: ['רכבת', 'אגד', 'דן', 'מטרופולין', 'פנגו', 'pango', 'gett', 'גט', 'cibus'] }
];

function autoDetectCategory(text, defaultCategory = 'אשראי') {
    if (!text) return defaultCategory;
    const lower = text.toLowerCase();
    for (const item of STORE_CATEGORY_MAP) {
        for (const kw of item.keywords) {
            if (lower.includes(kw.toLowerCase())) {
                return item.category;
            }
        }
    }
    return defaultCategory;
}

function autoDetectTripCategory(text) {
    const lower = (text || '').toLowerCase();
    if (lower.includes('טיסה') || lower.includes('טיסות') || lower.includes('flight')) return 'טיסות';
    if (lower.includes('מלון') || lower.includes('מלונות') || lower.includes('דירה') || lower.includes('hotel') || lower.includes('airbnb')) return 'מלונות';
    if (lower.includes('מסעדה') || lower.includes('מסעדות') || lower.includes('אוכל') || lower.includes('קפה') || lower.includes('food')) return 'מסעדות ואוכל';
    if (lower.includes('רכב') || lower.includes('דלק') || lower.includes('מונית') || lower.includes('תחבורה') || lower.includes('car') || lower.includes('taxi')) return 'תחבורה ורכב';
    if (lower.includes('קניות') || lower.includes('שופינג') || lower.includes('אטרקציה') || lower.includes('מוזיאון')) return 'אטרקציות וקניות';
    return 'שונות';
}

const BACKUP_EMAIL = process.env.BACKUP_EMAIL || 'nadav.fraid@gmail.com';
const SMTP_USER = process.env.SMTP_USER || 'nadav.fraid@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS || '';

async function sendBackupEmail() {
    console.log('📦 מתחיל תהליך שליחת גיבוי למייל...');
    const dbPath = path.join(__dirname, 'data', 'budget.db');
    if (!fs.existsSync(dbPath)) return { success: false, error: 'Database file not found' };
    if (!SMTP_USER || !SMTP_PASS) return { success: false, error: 'SMTP credentials missing' };

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: SMTP_USER, pass: SMTP_PASS }
        });

        const dateStr = new Date().toISOString().slice(0, 10);
        const info = await transporter.sendMail({
            from: `"Budget Backup" <${SMTP_USER}>`,
            to: BACKUP_EMAIL,
            subject: `📊 גיבוי תקציב משפחתי יומי - ${dateStr}`,
            text: `מצורף קובץ בסיס הנתונים budget.db מעודכן להיום (${dateStr}).`,
            attachments: [{ filename: `backup-budget-${dateStr}.db`, path: dbPath }]
        });

        console.log('✅ הגיבוי נשלח בהצלחה למייל!');
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error('❌ שגיאה בשליחת מייל הגיבוי:', err.message);
        return { success: false, error: err.message };
    }
}

cron.schedule('0 1 * * *', () => sendBackupEmail(), { timezone: TZ_NAME });

cron.schedule('0 8 * * *', async () => {
    try {
        const executed = await processDueRecurringExpenses();
        for (const item of executed) {
            if (client && client.info && TARGET_GROUP_ID) {
                const catStats = await getCategoryRemaining(item.category);
                let msgText = `🔄 **תשלום קבוע הופעל אוטומטית:**\n• תשלום: ${item.title}\n• סכום: ₪${item.amount}\n• קטגוריה: ${item.category}`;
                if (catStats.limit > 0) {
                    msgText += `\n\n📊 מצב תקציב (${item.category}):\n• מסגרת: ₪${catStats.limit}\n• נותר בסעיף: ₪${catStats.remaining}`;
                }
                await client.sendMessage(TARGET_GROUP_ID, msgText);
            }
        }
    } catch (err) {
        console.error('שגיאה בעיבוד הוראות קבע:', err);
    }
}, { timezone: TZ_NAME });

const app = express();

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post('/api/quick-add', async (req, res) => {
    if (!QUICK_ADD_KEY) {
        return res.status(503).json({ error: 'quick-add מושבת: לא הוגדר QUICK_ADD_KEY בשרת' });
    }
    if (!safeEqual(req.headers['x-api-key'] || '', QUICK_ADD_KEY)) {
        return res.status(401).json({ error: 'מפתח לא תקין' });
    }
    try {
        let { amount, category, description, sender } = req.body;
        let parsedAmount = 0;
        const fullText = `${amount || ''} ${description || ''}`.replace(/,/g, '');
        const matches = fullText.match(/(\d+(?:\.\d+)?)/g);

        if (matches && matches.length > 0) parsedAmount = parseFloat(matches[0]);
        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount === 0) {
            return res.status(400).json({ error: 'לא זוהה סכום נומרי בהתראה', received: fullText });
        }

        let finalCategory = category || 'אשראי';
        if (finalCategory === 'אשראי') finalCategory = autoDetectCategory(fullText, 'אשראי');

        await addExpense(sender || 'Google Wallet', finalCategory, parsedAmount, description || fullText, fullText);
        res.json({ success: true, amount: parsedAmount, category: finalCategory });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Home-screen icon requests may be made outside the authenticated browser
// session, so expose only these non-sensitive static assets before Basic Auth.
const publicIconAssets = [
    '/favicon.ico',
    '/favicon-48.png',
    '/icon.svg',
    '/icon-192.png',
    '/icon-512.png',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
    '/manifest.json'
];

app.get(publicIconAssets, (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(__dirname, 'public', req.path.slice(1)));
});

app.use((req, res, next) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const decoded = Buffer.from(b64auth, 'base64').toString();
    const sep = decoded.indexOf(':');
    const login = sep >= 0 ? decoded.slice(0, sep) : '';
    const password = sep >= 0 ? decoded.slice(sep + 1) : '';

    if (login && password && safeEqual(login, AUTH_USER) && safeEqual(password, AUTH_PASS)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Family Budget"');
    res.status(401).send('נדרשת הזדהות לצפייה בתקציב המשפחתי');
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/test-backup', async (req, res) => {
    const result = await sendBackupEmail();
    res.json(result);
});

app.get('/api/expenses', async (req, res) => { try { res.json(await getExpenses()); } catch (err) { res.status(500).json({ error: err.message }); } });

app.delete('/api/expenses/:id', async (req, res) => {
    try {
        await deleteExpense(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', async (req, res) => { try { res.json(await getMonthlyStats()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/monthly-summary/months', async (req, res) => {
    try { res.json(await getAvailableMonths()); } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/monthly-summary', async (req, res) => {
    try {
        const month = req.query.month || currentMonthStr();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'פורמט חודש לא תקין (YYYY-MM)' });
        res.json(await getMonthSummary(month));
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/budgets', async (req, res) => {
    try {
        const budgets = await getBudgets();
        const stats = await getMonthlyStats();
        const combined = budgets.map(b => {
            const stat = stats.find(s => s.category === b.category);
            const spent = stat ? stat.total : 0;
            return { id: b.id, category: b.category, monthly_limit: b.monthly_limit, spent: spent, remaining: b.monthly_limit - spent };
        });
        res.json(combined);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/budgets', async (req, res) => {
    try {
        const { category, monthly_limit } = req.body;
        if (!category || monthly_limit === undefined) return res.status(400).json({ error: 'חסרים נתונים' });
        await setBudget(category, parseFloat(monthly_limit));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/recurring', async (req, res) => {
    try { res.json(await getRecurringExpenses()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/recurring', async (req, res) => {
    try {
        const { title, category, amount, day_of_month, description } = req.body;
        if (!title || !category || !amount || !day_of_month) return res.status(400).json({ error: 'חסרים נתונים' });
        await addRecurringExpense(title, category, parseFloat(amount), parseInt(day_of_month), description || '');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/recurring/:id', async (req, res) => {
    try {
        await deleteRecurringExpense(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/* נתיבי API לטיול */
app.get('/api/trip/expenses', async (req, res) => {
    try { res.json(await getTripExpenses()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trip/expenses', async (req, res) => {
    try {
        const { category, amount, description } = req.body;
        if (!category || !amount) return res.status(400).json({ error: 'חסרים נתונים' });
        await addTripExpense(category, parseFloat(amount), description || '');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/trip/expenses/:id', async (req, res) => {
    try {
        await deleteTripExpense(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trip/summary', async (req, res) => {
    try { res.json(await getTripSummary()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/trip/budget', async (req, res) => {
    try {
        const { limit } = req.body;
        if (limit === undefined) return res.status(400).json({ error: 'חסרים נתונים' });
        await setTripBudget(parseFloat(limit));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.put("/api/expenses/:id", async (req, res) => {
    const id = req.params.id;
    const category = req.body ? req.body.category : null;
    if (!category) {
        return res.status(400).json({ error: "קטגוריה ריקה" });
    }
    try {
        const dbModule = require("./db");
        if (dbModule.updateExpenseCategory) {
            await dbModule.updateExpenseCategory(id, category);
            return res.json({ success: true });
        }
        res.status(500).json({ error: "פונקציית עדכון לא נמצאה" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});



app.delete("/api/budgets/:id", async (req, res) => {
    try {
        const { deleteBudget } = require("./db");
        await deleteBudget(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.listen(PORT, () => {
    console.log(`🌐 Dashboard זמין בכתובת: http://localhost:${PORT}`);
});

const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-process-singleton']
    }
});

client.on('qr', (qr) => {
    console.log('סרוק את קוד ה-QR בטלפון:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('🟢 הבוט מחובר בהצלחה ל-WhatsApp!');
});

const handleBudgetMessage = createMessageHandler({
    client,
    homeBudgetGroups: HOME_BUDGET_GROUPS,
    tripBudgetGroups: TRIP_BUDGET_GROUPS,
    cleanString,
    autoDetectCategory,
    autoDetectTripCategory,
    addExpense,
    deleteLastExpense,
    getCategoryRemaining,
    addTripExpense,
    deleteLastTripExpense,
    getTripSummary,
    onHomeGroupDetected: chatId => { TARGET_GROUP_ID = chatId; }
});

// "message" covers messages received from other family members. "message_create"
// also covers messages sent from the WhatsApp account connected to the bot.
// The shared handler deduplicates the incoming messages emitted by both events.
client.on('message', msg => handleBudgetMessage(msg, 'message'));
client.on('message_create', msg => handleBudgetMessage(msg, 'message_create'));

client.on('message_ack', (msg, ack) => {
    const messageId = msg?.id?._serialized || msg?.id?.id || 'ללא מזהה';
    console.log(`📬 אישור מסירה ${ack} להודעה ${messageId}`);
});

client.on('auth_failure', message => {
    console.error('❌ אימות WhatsApp נכשל:', message);
});

client.on('disconnected', reason => {
    console.error('🔴 חיבור WhatsApp נותק:', reason);
});

client.on('change_state', state => {
    console.log(`🔄 מצב חיבור WhatsApp: ${state}`);
});

client.initialize();
