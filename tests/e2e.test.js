'use strict';

const { before, after, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockServer, sleep, startNdjson } = require('./mock-server.js');
const { launchBrowser, openApp, sendMessage, readDbSnapshot } = require('./e2e-helpers.js');

let server;
let browser;
let port;

before(async () => {
    server = createMockServer();
    port = await server.listen();
    browser = await launchBrowser();
});

beforeEach(() => {
    server.state.chatHandler = null;
    server.state.requests.length = 0;
});

after(async () => {
    await browser?.close();
    await server?.close();
});

test('server-provided model names are rendered as text, not HTML', async () => {
    const payload = '<img src=x onerror=__modelXss=1>cloud';
    server.state.models = ['good-model:latest-cloud', payload];

    const { context, page } = await openApp(browser, port);

    try {
        const names = await page.$$eval('#model-list .model-option .model-name', (elements) =>
            elements.map((element) => element.textContent)
        );
        assert.ok(names.includes(payload), 'the literal model name should be visible');
        assert.equal(await page.evaluate(() => window.__modelXss), undefined);

        await page.click('#settings-btn-sidebar');
        await page.click('#toggle-local-list-btn');
        assert.equal(await page.evaluate(() => window.__modelXss), undefined);
    } finally {
        await context.close();
    }
});

test('chat titles are rendered as text, not HTML', async () => {
    server.state.models = ['good-model:latest-cloud'];
    const payload = '<img src=x onerror=__tx=1>';

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, payload);
        await page.waitForSelector('.chat-item-title');

        assert.equal(await page.evaluate(() => window.__tx), undefined);
        assert.equal((await page.textContent('.chat-item-title')).trim(), payload);
    } finally {
        await context.close();
    }
});

test('scrollToBottom moves the chat scroller to the latest content', async () => {
    server.state.models = ['good-model:latest-cloud'];
    const { context, page } = await openApp(browser, port);

    try {
        const metrics = await page.evaluate(() => {
            const area = document.getElementById('messages-area');
            for (let index = 0; index < 80; index += 1) {
                const message = document.createElement('div');
                message.className = 'message assistant-msg';
                message.textContent = `Line ${index} ${'lorem ipsum '.repeat(20)}`;
                area.appendChild(message);
            }
            scrollToBottom();
            const scroller = document.getElementById('chat-container');
            return {
                scrollTop: scroller.scrollTop,
                scrollHeight: scroller.scrollHeight,
                clientHeight: scroller.clientHeight
            };
        });

        assert.ok(metrics.scrollHeight > metrics.clientHeight, 'test content should overflow');
        assert.ok(metrics.scrollTop > 0, 'the chat scroller should have moved');
        assert.ok(
            Math.abs(metrics.scrollTop + metrics.clientHeight - metrics.scrollHeight) <= 2,
            'the chat scroller should be pinned to the bottom'
        );
    } finally {
        await context.close();
    }
});

test('mobile sidebar closes from the overlay and Escape', async () => {
    server.state.models = ['good-model:latest-cloud'];
    const { context, page } = await openApp(browser, port, {}, { width: 375, height: 667 });

    try {
        await page.click('#menu-btn');
        await page.waitForFunction(() => {
            const style = getComputedStyle(document.getElementById('overlay'));
            return style.opacity === '1' && style.pointerEvents === 'auto';
        });

        await page.mouse.click(350, 300);
        await page.waitForFunction(
            () => !document.getElementById('sidebar').classList.contains('open')
        );

        await page.click('#menu-btn');
        await page.keyboard.press('Escape');
        await page.waitForFunction(
            () => !document.getElementById('sidebar').classList.contains('open')
        );
    } finally {
        await context.close();
    }
});

test('stop button persists a partial answer and reuses it as context', async () => {
    server.state.models = ['good-model:latest-cloud'];
    server.state.chatHandler = async (req, res, body) => {
        const stream = startNdjson(res, body.model);
        stream.chunk({ role: 'assistant', content: 'Part one' });
        await sleep(2000);
        stream.chunk({ role: 'assistant', content: ' part two' });
        stream.end();
    };

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, 'slow prompt');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('Part one'),
            null,
            { timeout: 10000 }
        );
        await page.waitForFunction(
            () => getComputedStyle(document.getElementById('stop-btn')).display !== 'none'
        );

        await page.click('#stop-btn');
        await page.waitForFunction(() => {
            const stop = document.getElementById('stop-btn');
            const send = document.getElementById('send-btn');
            return getComputedStyle(stop).display === 'none'
                && getComputedStyle(send).display !== 'none';
        });

        await page.waitForSelector('.msg-status');
        assert.equal((await page.textContent('.msg-status')).trim(), 'Interrupted');

        const stopped = await readDbSnapshot(page);
        assert.equal(stopped.messages.length, 2, 'only the user message and partial answer should exist');
        const partial = stopped.messages.find((message) => message.role === 'assistant');
        assert.equal(partial.status, 'interrupted');
        assert.ok(partial.content.includes('Part one'));
        assert.equal(partial.content.includes('part two'), false);

        server.state.chatHandler = null;
        await sendMessage(page, 'continue please');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        const followUp = server.state.requests.at(-1);
        assert.deepEqual(
            followUp.messages.map((message) => message.role),
            ['user', 'assistant', 'user']
        );
        assert.ok(followUp.messages[1].content.includes('Part one'));
    } finally {
        await context.close();
    }
});

test('switching chats mid-stream saves the partial answer without leaking it', async () => {
    server.state.models = ['good-model:latest-cloud'];

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, 'hello one');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        await page.click('#header-new-chat-btn');
        await sendMessage(page, 'hello two');
        await page.waitForFunction(
            () => document.querySelectorAll('.chat-item').length === 2
                && document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        server.state.chatHandler = async (req, res, body) => {
            const stream = startNdjson(res, body.model);
            stream.chunk({ role: 'assistant', content: 'SLOW-1' });
            await sleep(2500);
            stream.chunk({ role: 'assistant', content: ' SLOW-2' });
            stream.end();
        };

        await sendMessage(page, 'slow prompt');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('SLOW-1'),
            null,
            { timeout: 10000 }
        );

        // Chat A is the second item because chats are ordered newest first.
        await page.click('.chat-item:nth-child(2)');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('hello one'),
            null,
            { timeout: 10000 }
        );

        const switched = await readDbSnapshot(page);
        assert.equal(
            switched.messages.filter((message) => message.chat_id === 0).length,
            0,
            'no message may be stored against a missing chat'
        );

        const chatA = switched.chats.find((chat) => chat.title === 'hello one');
        const chatB = switched.chats.find((chat) => chat.title === 'hello two');
        assert.ok(chatA && chatB, 'both chats should exist');

        const chatAMessages = switched.messages.filter((message) => message.chat_id === chatA.id);
        const chatBMessages = switched.messages.filter((message) => message.chat_id === chatB.id);
        assert.deepEqual(chatAMessages.map((message) => message.role), ['user', 'assistant']);
        assert.equal(chatBMessages.length, 4, 'chat B keeps two complete messages plus the new prompt and its partial answer');

        const partial = chatBMessages.find((message) => message.status === 'interrupted');
        assert.ok(partial, 'the interrupted answer should be saved in chat B');
        assert.ok(partial.content.includes('SLOW-1'));
        assert.equal(partial.content.includes('SLOW-2'), false);

        await sleep(2800);
        const later = await readDbSnapshot(page);
        const laterPartial = later.messages.find((message) => message.id === partial.id);
        assert.equal(laterPartial.content.includes('SLOW-2'), false, 'late chunks must not reach the stored answer');
        assert.equal(later.messages.filter((message) => message.chat_id === 0).length, 0);

        // Re-open chat B: the partial answer is rendered with its status badge.
        await page.click('.chat-item:nth-child(1)');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('SLOW-1'),
            null,
            { timeout: 10000 }
        );
        assert.equal((await page.textContent('.msg-status')).trim(), 'Interrupted');
    } finally {
        await context.close();
    }
});

test('an unterminated final NDJSON line is still rendered and saved', async () => {
    server.state.models = ['good-model:latest-cloud'];
    server.state.chatHandler = (req, res, body) => {
        const stream = startNdjson(res, body.model);
        stream.chunk({ role: 'assistant', content: 'Tail ' });
        // Final line deliberately has no trailing newline.
        res.write(JSON.stringify({
            model: body.model,
            message: { role: 'assistant', content: 'complete' },
            done: true
        }));
        res.end();
    };

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, 'ndjson tail');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('Tail complete'),
            null,
            { timeout: 10000 }
        );
        await page.waitForFunction(
            () => getComputedStyle(document.getElementById('stop-btn')).display === 'none'
        );

        const snapshot = await readDbSnapshot(page);
        const assistant = snapshot.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.content, 'Tail complete');
        assert.equal(assistant.status, 'complete');
    } finally {
        await context.close();
    }
});

test('an NDJSON line split across network writes is reassembled', async () => {
    server.state.models = ['good-model:latest-cloud'];
    server.state.chatHandler = async (req, res, body) => {
        const stream = startNdjson(res, body.model);
        res.write('{"model":"' + body.model + '","message":{"role":"assistant","content":"Spl');
        await sleep(250);
        res.write('it answer"},"done":false}\n');
        await sleep(100);
        stream.end();
    };

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, 'split line');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('Split answer'),
            null,
            { timeout: 10000 }
        );
        await page.waitForFunction(
            () => getComputedStyle(document.getElementById('stop-btn')).display === 'none'
        );

        const snapshot = await readDbSnapshot(page);
        const assistant = snapshot.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.content, 'Split answer');
        assert.equal(assistant.status, 'complete');
    } finally {
        await context.close();
    }
});

test('an error payload stops the stream, shows the error and keeps the partial answer', async () => {
    server.state.models = ['good-model:latest-cloud'];
    server.state.chatHandler = (req, res, body) => {
        const stream = startNdjson(res, body.model);
        stream.chunk({ role: 'assistant', content: 'Partial answer' });
        res.write(JSON.stringify({ error: 'model overloaded' }) + '\n');
        res.end();
    };

    const { context, page } = await openApp(browser, port);

    try {
        await sendMessage(page, 'stream error');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('Error: model overloaded'),
            null,
            { timeout: 10000 }
        );
        await page.waitForSelector('.msg-status');

        assert.equal((await page.textContent('.msg-status')).trim(), 'Interrupted');

        const snapshot = await readDbSnapshot(page);
        const assistant = snapshot.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.content, 'Partial answer');
        assert.equal(assistant.status, 'interrupted');
    } finally {
        await context.close();
    }
});
