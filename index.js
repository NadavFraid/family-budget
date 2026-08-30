const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { 
    addExpense, deleteLastExpense, getExpenses, getMonthlyStats, 
    getBudgets, setBudget, getCategoryRemaining,
    addRecurringExpense, getRecurringExpenses, deleteRecurringExpense, processDueRecurringExpenses 
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

const AUTH_USER = 'family';
const AUTH_PASS = '123456';
let TARGET_GROUP_ID = '';

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

const BACKUP_EMAIL = process.env.BACKUP_EMAIL || 'nadav.fraid@gmail.com';
const SMTP_USER = process.env.SMTP_USER || 'nadav.fraid@gmail.com';
const SMTP_PASS = process.env.SMTP_PASS || '';

async function sendBackupEmail() {
    console.log('--------------------------------------------------');
    console.log('📦 מתחיל תהליך שליחת גיבוי למייל...');
    console.log(`📧 נשלח אל: ${BACKUP_EMAIL}`);
    console.log(`👤 משתמש SMTP: ${SMTP_USER}`);
    console.log(`🔑 אורך סיסמת SMTP שהתקבלה: ${SMTP_PASS ? SMTP_PASS.length : 0} תווים`);

    const dbPath = path.join(__dirname, 'data', 'budget.db');
    if (!fs.existsSync(dbPath)) {
        console.error('❌ שגיאה: קובץ בסיס הנתונים budget.db לא נמצא בנתיב:', dbPath);
        return { success: false, error: 'Database file not found' };
    }

    if (!SMTP_USER || !SMTP_PASS) {
        console.error('❌ שגיאה: חסרים פרטי SMTP_USER או SMTP_PASS במשתני הסביבה!');
        return { success: false, error: 'SMTP credentials missing' };
    }

    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS
            }
        });

        const dateStr = new Date().toISOString().slice(0, 10);
        const info = await transporter.sendMail({
            from: `"Budget Backup" <${SMTP_USER}>`,
            to: BACKUP_EMAIL,
            subject: `📊 גיבוי תקציב משפחתי יומי - ${dateStr}`,
            text: `מצורף קובץ בסיס הנתונים budget.db מעודכן להיום (${dateStr}).`,
            attachments: [{ filename: `budget-backup-${dateStr}.db`, path: dbPath }]
        });

        console.log('✅ הגיבוי נשלח בהצלחה למייל!');
        console.log('📩 מזהה הודעה (Message ID):', info.messageId);
        console.log('--------------------------------------------------');
        return { success: true, messageId: info.messageId };
    } catch (err) {
        console.error('❌ שגיאה בשליחת מייל הגיבוי:', err.message);
        if (err.response) console.error('🔍 תשובת שרת Gmail:', err.response);
        console.log('--------------------------------------------------');
        return { success: false, error: err.message, response: err.response };
    }
}

// גיבוי לילי ב-01:00 בבוקר
cron.schedule('0 1 * * *', () => sendBackupEmail());

// בדיקה יומית של הוראות קבע בשעה 08:00 בבוקר
cron.schedule('0 8 * * *', async () => {
    console.log('🔄 בודק הוראות קבע להיום...');
    try {
        const executed = await processDueRecurringExpenses();
        for (const item of executed) {
            console.log(`✅ הוראת קבע הופעלה: ${item.title} - ₪${item.amount}`);
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
});

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

app.post('/api/quick-add', async (req, res) => {
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

app.use((req, res, next) => {
    const auth = { login: AUTH_USER, password: AUTH_PASS };
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === auth.login && password === auth.password) return next();
    res.set('WWW-Authenticate', 'Basic realm="Family Budget"');
    res.status(401).send('נדרשת הזדהות לצפייה בתקציב המשפחתי');
});

app.use(express.static(path.join(__dirname, 'public')));

// נתיב לבדיקת גיבוי למייל בלחיצה/פקודה
app.get('/api/test-backup', async (req, res) => {
    console.log('🧪 נקראה בקשת בדיקה ידנית לשליחת גיבוי למייל (/api/test-backup)');
    const result = await sendBackupEmail();
    res.json(result);
});

app.get('/api/expenses', async (req, res) => { try { res.json(await getExpenses()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/stats', async (req, res) => { try { res.json(await getMonthlyStats()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/budgets', async (req, res) => {
    try {
        const budgets = await getBudgets();
        const stats = await getMonthlyStats();
        const combined = budgets.map(b => {
            const stat = stats.find(s => s.category === b.category);
            const spent = stat ? stat.total : 0;
            return { category: b.category, monthly_limit: b.monthly_limit, spent: spent, remaining: b.monthly_limit - spent };
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

client.on('ready', () => console.log('🟢 הבוט מחובר בהצלחה ל-WhatsApp!'));

client.on('message_create', async (msg) => {
    try {
        const text = msg.body ? msg.body.trim() : '';
        if (!text) return;

        const chatId = (msg.from && msg.from.endsWith('@g.us')) ? msg.from : 
                       (msg.to && msg.to.endsWith('@g.us')) ? msg.to : null;

        if (!chatId) return;
        TARGET_GROUP_ID = chatId;

        if (text.toLowerCase() === 'ביטול' || text.toLowerCase() === 'מחק' || text.toLowerCase() === 'undo') {
            const deleted = await deleteLastExpense();
            if (deleted) {
                await client.sendMessage(chatId, `🗑️ ההוצאה האחרונה בוטלה ונמחקה בהצלחה:\n• סכום: ₪${deleted.amount}\n• קטגוריה: ${deleted.category}${deleted.description ? `\n• תיאור: ${deleted.description}` : ''}`);
            } else {
                await client.sendMessage(chatId, `⚠️ לא נמצאה הוצאה אחרונה לביטול.`);
            }
            return;
        }

        const match = text.match(/^(\S+)\s+(\d+(?:\.\d+)?)(?:\s+(.*))?$/);

        if (match) {
            let category = match[1];
            const amount = parseFloat(match[2]);
            const description = match[3] || '';
            const senderName = msg._data?.notifyName || (msg.author ? msg.author.split('@')[0] : 'בן משפחה');

            category = autoDetectCategory(`${category} ${description}`, category);

            await addExpense(senderName, category, amount, description, text);
            console.log(`✅ הוצאה נשמרה: ₪${amount} | ${category}`);

            const catStats = await getCategoryRemaining(category);
            let replyText = `👍 נרשם בהצלחה:\n• סכום: ₪${amount}\n• קטגוריה: ${category}${description ? `\n• תיאור: ${description}` : ''}`;
            
            if (catStats.limit > 0) {
                replyText += `\n\n📊 מצב תקציב (${category}):\n• מסגרת: ₪${catStats.limit}\n• הוצא החודש: ₪${catStats.spent}\n• נותר בסעיף: ₪${catStats.remaining}`;
            }

            await client.sendMessage(chatId, replyText);
        }
    } catch (err) {
        console.error('שגיאה בעיבוד ההודעה:', err);
    }
});

client.initialize();
