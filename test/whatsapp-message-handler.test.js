'use strict';

const assert = require('node:assert/strict');
const { createMessageHandler, getGroupId, isBotResponse } = require('../whatsapp-message-handler');

const HOME_GROUP = 'home@g.us';
const TRIP_GROUP = 'trip@g.us';

function createHarness() {
    const calls = {
        expenses: [],
        tripExpenses: [],
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
        getCategoryRemaining: async () => ({ limit: 0, spent: 0, remaining: 0 }),
        addTripExpense: async (...args) => calls.tripExpenses.push(args),
        deleteLastTripExpense: async () => null,
        getTripSummary: async () => ({ limit: 0, spent: 0, remaining: 0 }),
        onHomeGroupDetected: chatId => calls.detectedGroups.push(chatId),
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

async function run() {
    assert.equal(getGroupId({ from: HOME_GROUP, to: 'person@c.us' }), HOME_GROUP);
    assert.equal(getGroupId({ from: 'person@lid', to: HOME_GROUP }), HOME_GROUP);
    assert.equal(isBotResponse('👍 נרשם בהצלחה'), true);

    await testIncomingMessageIsDeduplicated();
    await testOwnGroupMessageIsProcessed();
    await testBotConfirmationIsIgnored();
    console.log('WhatsApp message handler tests passed');
}

run().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
