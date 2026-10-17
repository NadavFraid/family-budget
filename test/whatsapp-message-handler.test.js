'use strict';

const assert = require('node:assert/strict');
const { createMessageHandler, getGroupId, isBotResponse } = require('../whatsapp-message-handler');

const HOME_GROUP = 'home@g.us';
const TRIP_GROUP = 'trip@g.us';
const TODAY = '2026-10-16';

function createHarness({ budgetLimit = 0 } = {}) {
    const calls = {
        expenses: [],
        tripExpenses: [],
        categoryQueries: [],
        sent: [],
        detectedGroups: []
    };
    const client = {
        async sendMessage(chatId, text) {
            calls.sent.push({ chatId, text });
            return { id: { _serialized: `sent-${calls.sent.length}` } };
        }
    };
    const handler = createMessageHandler({
        client,
        homeBudgetGroups: [HOME_GROUP, 'תקציב משפחתי'],
        tripBudgetGroups: [TRIP_GROUP, 'תקציב טיול'],
        cleanString: value => (value || '').trim().toLowerCase(),
        autoDetectCategory: (text, fallback) => fallback,
        autoDetectTripCategory: () => 'שונות',
        addExpense: async (...args) => calls.expenses.push(args),
        deleteLastExpense: async () => null,
        getCategoryRemaining: async (...args) => {
            calls.categoryQueries.push(args);
            return { limit: budgetLimit, spent: 300, remaining: budgetLimit - 300 };
        },
        addTripExpense: async (...args) => calls.tripExpenses.push(args),
        deleteLastTripExpense: async () => null,
        getTripSummary: async () => ({ limit: 0, spent: 0, remaining: 0 }),
        onHomeGroupDetected: chatId => calls.detectedGroups.push(chatId),
        getToday: () => TODAY,
        logger: { log() {}, debug() {}, error() {} }
    });

    return { calls, handler };
}

async function testIncomingMessageIsDeduplicated() {
    const { calls, handler } = createHarness();
    const message = {
        id: { _serialized: 'incoming-1' },
        from: HOME_GROUP,
        to: 'bot@c.us',
        author: 'family-member@c.us',
        body: '120 סופר קניות'
    };

    await Promise.all([
        handler(message, 'message_create'),
        handler(message, 'message')
    ]);

    assert.equal(calls.expenses.length, 1, 'an incoming message must create one expense');
    assert.equal(calls.sent.length, 1, 'an incoming message must receive one confirmation');
    assert.equal(calls.sent[0].chatId, HOME_GROUP);
}

async function testOwnGroupMessageIsProcessed() {
    const { calls, handler } = createHarness();
    await handler({
        id: { _serialized: 'outgoing-1' },
        from: 'connected-account@lid',
        to: HOME_GROUP,
        body: '50 קפה'
    }, 'message_create');

    assert.equal(calls.expenses.length, 1, 'a message from the connected account must be processed');
    assert.equal(calls.sent.length, 1);
    assert.deepEqual(calls.detectedGroups, [HOME_GROUP]);
}

async function testBotConfirmationIsIgnored() {
    const { calls, handler } = createHarness();
    await handler({
        id: { _serialized: 'bot-1' },
        from: 'connected-account@lid',
        to: HOME_GROUP,
        body: '👍 נרשם בהצלחה:\n• סכום: ₪50'
    }, 'message_create');

    assert.equal(calls.expenses.length, 0);
    assert.equal(calls.sent.length, 0);
}

let messageCounter = 0;
function groupMessage(body, group = HOME_GROUP) {
    messageCounter += 1;
    return { id: { _serialized: `date-test-${messageCounter}` }, from: group, to: 'bot@c.us', author: 'family-member@c.us', body };
}

async function testHomeExpenseWithRelativeDate() {
    const { calls, handler } = createHarness();
    await handler(groupMessage('120 סופר אתמול'), 'message');

    assert.equal(calls.expenses.length, 1);
    const [, category, amount, , rawText, date] = calls.expenses[0];
    assert.equal(category, 'סופר');
    assert.equal(amount, 120);
    assert.equal(date, '2026-10-15');
    assert.equal(rawText, '120 סופר אתמול', 'the original message is kept as raw text');
    assert.match(calls.sent[0].text, /תאריך: 15\/10\/2026/);
}

async function testExplicitDateIsNotReadAsAmount() {
    for (const body of ['80 דלק 15/10', '15/10 80 דלק']) {
        const { calls, handler } = createHarness();
        await handler(groupMessage(body), 'message');

        assert.equal(calls.expenses.length, 1, body);
        const [, category, amount, , , date] = calls.expenses[0];
        assert.equal(amount, 80, `amount of "${body}" must not be the day of the date`);
        assert.equal(category, 'דלק', body);
        assert.equal(date, '2026-10-15', body);
    }
}

async function testNoDateKeepsOldBehaviour() {
    const { calls, handler } = createHarness();
    await handler(groupMessage('50 קפה'), 'message');

    assert.equal(calls.expenses[0][5], null, 'no date in the message means the DB default (today)');
    assert.doesNotMatch(calls.sent[0].text, /תאריך/);

    const todayWord = createHarness();
    await todayWord.handler(groupMessage('50 קפה היום'), 'message');
    assert.equal(todayWord.calls.expenses[0][5], TODAY);
    assert.doesNotMatch(todayWord.calls.sent[0].text, /תאריך/, 'today needs no extra date line');
}

async function testPastMonthUsesThatMonthsBudget() {
    const { calls, handler } = createHarness({ budgetLimit: 1000 });
    await handler(groupMessage('200 סופר 3/9'), 'message');

    assert.equal(calls.expenses[0][5], '2026-09-03');
    assert.deepEqual(calls.categoryQueries[0], ['סופר', '2026-09']);
    assert.match(calls.sent[0].text, /09\/2026/);
    assert.match(calls.sent[0].text, /הוצא באותו חודש/);

    const current = createHarness({ budgetLimit: 1000 });
    await current.handler(groupMessage('200 סופר'), 'message');
    assert.deepEqual(current.calls.categoryQueries[0], ['סופר', '2026-10']);
    assert.match(current.calls.sent[0].text, /הוצא החודש/);
}

async function testBadDateIsRejectedWithWarning() {
    for (const [body, reason] of [['50 קפה 31/2', 'אינו תקין'], ['50 קפה 20/10/2026', 'עדיין לא הגיע']]) {
        const { calls, handler } = createHarness();
        await handler(groupMessage(body), 'message');

        assert.equal(calls.expenses.length, 0, `"${body}" must not be saved`);
        assert.equal(calls.sent.length, 1);
        assert.ok(calls.sent[0].text.startsWith('⚠️'), 'warnings start with the bot marker so they are not re-processed');
        assert.ok(calls.sent[0].text.includes(reason), body);
        assert.equal(isBotResponse(calls.sent[0].text), true);
    }
}

async function testChatWithBadDateButNoAmountStaysSilent() {
    const { calls, handler } = createHarness();
    await handler(groupMessage('נפגש ב-31/2'), 'message');

    assert.equal(calls.expenses.length, 0);
    assert.equal(calls.sent.length, 0, 'regular chat must not trigger a bot reply');
}

async function testTripExpenseWithDate() {
    const { calls, handler } = createHarness();
    await handler(groupMessage('500 מלון אתמול', TRIP_GROUP), 'message');
    assert.deepEqual(calls.tripExpenses[0], ['שונות', 500, 'מלון', '2026-10-15']);
    assert.match(calls.sent[0].text, /תאריך: 15\/10\/2026/);

    const noDate = createHarness();
    await noDate.handler(groupMessage('500 מלון', TRIP_GROUP), 'message');
    assert.equal(noDate.calls.tripExpenses[0][3], null);
}

async function run() {
    assert.equal(getGroupId({ from: HOME_GROUP, to: 'person@c.us' }), HOME_GROUP);
    assert.equal(getGroupId({ from: 'person@lid', to: HOME_GROUP }), HOME_GROUP);
    assert.equal(isBotResponse('👍 נרשם בהצלחה'), true);

    await testIncomingMessageIsDeduplicated();
    await testOwnGroupMessageIsProcessed();
    await testBotConfirmationIsIgnored();
    await testHomeExpenseWithRelativeDate();
    await testExplicitDateIsNotReadAsAmount();
    await testNoDateKeepsOldBehaviour();
    await testPastMonthUsesThatMonthsBudget();
    await testBadDateIsRejectedWithWarning();
    await testChatWithBadDateButNoAmountStaysSilent();
    await testTripExpenseWithDate();
    console.log('WhatsApp message handler tests passed');
}

run().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
