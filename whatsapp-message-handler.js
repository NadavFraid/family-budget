'use strict';

const { extractExpenseDate, formatDisplayDate, todayInTz } = require('./expense-date-parser');

const BOT_RESPONSE_MARKERS = [
    '👍',
    '✈️',
    '🗑️',
    '⚠️',
    '🔄'
];

function getMessageId(msg) {
    return msg?.id?._serialized || msg?.id?.id || null;
}

function getGroupId(msg) {
    if (typeof msg?.from === 'string' && msg.from.endsWith('@g.us')) return msg.from;
    if (typeof msg?.to === 'string' && msg.to.endsWith('@g.us')) return msg.to;
    return null;
}

function isBotResponse(text) {
    return BOT_RESPONSE_MARKERS.some(marker => text.startsWith(marker)) ||
        text.includes('נרשם בהצלחה') ||
        text.includes('נרשמה הוצאה') ||
        text.includes('הופעל אוטומטית');
}

function createMessageHandler({
    client,
    homeBudgetGroups,
    tripBudgetGroups,
    cleanString,
    autoDetectCategory,
    autoDetectTripCategory,
    addExpense,
    deleteLastExpense,
    getCategoryRemaining,
    addTripExpense,
    deleteLastTripExpense,
    getTripSummary,
    onHomeGroupDetected = () => {},
    getToday = todayInTz,
    logger = console
}) {
    const processedMessages = new Map();
    const MESSAGE_ID_TTL_MS = 5 * 60 * 1000;

    function rememberMessage(messageId) {
        if (!messageId) return false;

        const now = Date.now();
        for (const [id, timestamp] of processedMessages) {
            if (now - timestamp > MESSAGE_ID_TTL_MS) processedMessages.delete(id);
        }

        if (processedMessages.has(messageId)) return true;
        processedMessages.set(messageId, now);
        return false;
    }

    return async function handleBudgetMessage(msg, sourceEvent = 'unknown') {
        const messageId = getMessageId(msg);

        try {
            const text = typeof msg?.body === 'string' ? msg.body.trim() : '';
            if (!text) return;

            if (isBotResponse(text)) {
                logger.debug?.(`🤖 [${sourceEvent}] תגובת בוט סוננה (${messageId || 'ללא מזהה'})`);
                return;
            }

            const chatId = getGroupId(msg);
            if (!chatId) {
                logger.debug?.(`🙈 [${sourceEvent}] הודעה שאינה מקבוצה סוננה (${messageId || 'ללא מזהה'})`);
                return;
            }

            // Incoming messages are emitted as both "message_create" and "message".
            // Remember the WhatsApp ID before the first await so concurrent events cannot
            // write the same expense twice.
            if (rememberMessage(messageId)) {
                logger.debug?.(`♻️ [${sourceEvent}] אירוע כפול סונן (${messageId})`);
                return;
            }

            const rawGroupName = msg._data?.chat?.name ||
                msg._data?.chat?.formattedTitle ||
                msg._data?.groupMetadata?.subject ||
                msg._data?.name || '';
            const cleanedGroup = cleanString(rawGroupName);
            const isHomeGroup = homeBudgetGroups.includes(chatId) ||
                homeBudgetGroups.some(group => cleanString(group) === cleanedGroup);
            const isTripGroup = tripBudgetGroups.includes(chatId) ||
                tripBudgetGroups.some(group => cleanString(group) === cleanedGroup);

            logger.log(`📩 [${sourceEvent}] הודעה התקבלה בקבוצה ${chatId} (${messageId || 'ללא מזהה'})`);

            if (!isHomeGroup && !isTripGroup) {
                logger.log(`🙈 הקבוצה ${chatId} אינה מורשית; ההודעה לא עובדה`);
                return;
            }

            if (isHomeGroup) onHomeGroupDetected(chatId);

            const firstLine = text.split(/\r?\n/, 1)[0].trim();
            const command = firstLine.toLowerCase();

            if (command === 'ביטול' || command === 'מחק' || command === 'undo') {
                if (isTripGroup) {
                    const deleted = await deleteLastTripExpense();
                    const response = deleted
                        ? `🗑️ הוצאת הטיול האחרונה בוטלה ונמחקה:\n• סכום: ₪${deleted.amount}\n• קטגוריה: ${deleted.category}${deleted.description ? `\n• תיאור: ${deleted.description}` : ''}`
                        : '⚠️ לא נמצאה הוצאת טיול לביטול.';
                    await client.sendMessage(chatId, response);
                } else {
                    const deleted = await deleteLastExpense();
                    const response = deleted
                        ? `🗑️ ההוצאה השוטפת האחרונה בוטלה ונמחקה:\n• סכום: ₪${deleted.amount}\n• קטגוריה: ${deleted.category}${deleted.description ? `\n• תיאור: ${deleted.description}` : ''}`
                        : '⚠️ לא נמצאה הוצאה אחרונה לביטול.';
                    await client.sendMessage(chatId, response);
                }
                return;
            }

            // תאריך אופציונלי בהודעה ("אתמול", "לפני 3 ימים", "15/10"). הוא מוסר מהטקסט
            // לפני קריאת הסכום, כדי ש-15/10 לא יתפרש כסכום.
            const today = getToday();
            const parsedDate = extractExpenseDate(firstLine, today);

            if (parsedDate.error) {
                // רק הודעה שנראית כמו הוצאה (יש בה מספר מלבד התאריך) מקבלת אזהרה;
                // שיחה רגילה בקבוצה נשארת בשקט כמו קודם.
                if (!/\d/.test(firstLine.replace(parsedDate.match, ' '))) {
                    logger.log(`ℹ️ לא זוהה סכום בהודעה (${messageId || 'ללא מזהה'})`);
                    return;
                }
                const reason = parsedDate.error === 'future' ? 'התאריך עדיין לא הגיע' : 'התאריך אינו תקין';
                await client.sendMessage(chatId, `⚠️ ההוצאה לא נרשמה: ${reason} (${parsedDate.match}).\nשלחו שוב עם תאריך תקין (למשל 15/10 או "אתמול"), או בלי תאריך כדי לרשום להיום.`);
                return;
            }

            const lineText = parsedDate.rest;
            const expenseDate = parsedDate.date; // null = היום
            const dateLine = expenseDate && expenseDate !== today ? `\n• תאריך: ${formatDisplayDate(expenseDate)}` : '';

            const amountMatch = lineText.match(/(\d+(?:\.\d+)?)/);
            if (!amountMatch) {
                logger.log(`ℹ️ לא זוהה סכום בהודעה (${messageId || 'ללא מזהה'})`);
                return;
            }

            const amount = Number.parseFloat(amountMatch[0]);
            const restText = lineText.replace(amountMatch[0], '').trim();

            if (isTripGroup) {
                const category = autoDetectTripCategory(restText || lineText);
                const description = restText || 'הוצאת טיול';

                await addTripExpense(category, amount, description, expenseDate);
                const tripSummary = await getTripSummary();
                let replyText = `✈️ **נרשמה הוצאה לטיול:**\n• סכום: ₪${amount.toLocaleString()}\n• קטגוריה: ${category}\n• תיאור: ${description}${dateLine}`;
                if (tripSummary.limit > 0) {
                    replyText += `\n\n📊 **מצב תקציב הטיול:**\n• תקציב יעד: ₪${tripSummary.limit.toLocaleString()}\n• סך הוצאות: ₪${tripSummary.spent.toLocaleString()}\n• נותר לטיול: ₪${tripSummary.remaining.toLocaleString()}`;
                }

                const sent = await client.sendMessage(chatId, replyText);
                logger.log(`✅ הוצאת טיול נשמרה ואישור נשלח (${getMessageId(sent) || 'ללא מזהה שליחה'})`);
                return;
            }

            let category = restText.split(' ')[0] || 'אשראי';
            const description = restText.replace(category, '').trim() || restText;
            const senderName = msg._data?.notifyName ||
                (msg.author ? msg.author.split('@')[0] : 'בן משפחה');
            category = autoDetectCategory(`${category} ${description}`, category);

            await addExpense(senderName, category, amount, description, firstLine, expenseDate);
            // מצב התקציב מחושב לחודש של ההוצאה, כך שהוצאה מחודש קודם לא תוצג מול החודש הנוכחי.
            const statsMonth = (expenseDate || today).slice(0, 7);
            const isCurrentMonth = statsMonth === today.slice(0, 7);
            const categoryStats = await getCategoryRemaining(category, statsMonth);
            let replyText = `👍 נרשם בהצלחה:\n• סכום: ₪${amount.toLocaleString()}\n• קטגוריה: ${category}${description ? `\n• תיאור: ${description}` : ''}${dateLine}`;
            if (categoryStats.limit > 0) {
                const monthLabel = isCurrentMonth ? '' : `, ${statsMonth.slice(5)}/${statsMonth.slice(0, 4)}`;
                const spentLabel = isCurrentMonth ? 'הוצא החודש' : 'הוצא באותו חודש';
                replyText += `\n\n📊 מצב תקציב (${category}${monthLabel}):\n• מסגרת: ₪${categoryStats.limit.toLocaleString()}\n• ${spentLabel}: ₪${categoryStats.spent.toLocaleString()}\n• נותר בסעיף: ₪${categoryStats.remaining.toLocaleString()}`;
            }

            const sent = await client.sendMessage(chatId, replyText);
            logger.log(`✅ הוצאת בית נשמרה ואישור נשלח (${getMessageId(sent) || 'ללא מזהה שליחה'})`);
        } catch (err) {
            logger.error(`❌ שגיאה בעיבוד אירוע ${sourceEvent} (${messageId || 'ללא מזהה'}):`, err);
        }
    };
}

module.exports = {
    createMessageHandler,
    getGroupId,
    isBotResponse
};
