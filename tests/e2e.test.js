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

test('local models are listed without suffix filtering and duplicates are removed', async () => {
    server.state.models = [
        'llama3.1:8b',
        'remote-only:cloud',
        'llama3.1:8b',
        '   '
    ];

    const { context, page } = await openApp(browser, port, {
        cloudModels: JSON.stringify(['llama3.1:8b', 'remote-only:cloud', 'remote-only:cloud']),
        lastModel: 'removed-model:latest'
    });

    try {
        assert.deepEqual(
            await page.evaluate(() => state.localModels),
            ['llama3.1:8b', 'remote-only:cloud'],
            'every valid model from /api/tags should be kept'
        );
        assert.deepEqual(
            await page.evaluate(() => state.cloudModels),
            ['llama3.1:8b', 'remote-only:cloud'],
            'stored cloud models should be deduplicated'
        );

        const names = await page.$$eval('#model-list .model-option .model-name', (elements) =>
            elements.map((element) => element.textContent)
        );
        assert.deepEqual(names, ['llama3.1:8b', 'remote-only:cloud']);

        assert.equal(await page.evaluate(() => state.currentModel), 'llama3.1:8b');
        assert.equal((await page.textContent('#current-model-name')).trim(), 'llama3.1:8b');
        assert.equal(await page.evaluate(() => localStorage.getItem('lastModel')), 'llama3.1:8b');

        await sendMessage(page, 'local model');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );
    } finally {
        await context.close();
    }
});

test('cloud models are split into free and paid sections', async () => {
    server.state.models = ['llama3.1:8b', 'gemma4:31b'];

    const { context, page } = await openApp(browser, port, {
        cloudModels: JSON.stringify([
            'glm-4.7:cloud',
            'gpt-oss:20b-cloud',
            'gemma4:31b',
            'nemotron-3-super',
            'minimax-m2.1:cloud'
        ])
    });

    const readSections = () => page.$eval('#model-list', (list) => {
        const sections = {};
        let current = null;
        for (const child of Array.from(list.children)) {
            if (child.classList.contains('model-group-header')) {
                current = child.querySelector('.model-group-title').textContent;
                sections[current] = [];
            } else if (current && child.classList.contains('model-option')) {
                sections[current].push(child.querySelector('.model-name').textContent);
            }
        }
        return sections;
    });

    try {
        const sections = await readSections();
        assert.deepEqual(
            Object.keys(sections),
            ['LOCAL MODELS', 'FREE CLOUD MODELS', 'PAID CLOUD MODELS']
        );
        assert.deepEqual(sections['LOCAL MODELS'], ['llama3.1:8b', 'gemma4:31b']);
        assert.deepEqual(
            sections['FREE CLOUD MODELS'],
            ['gpt-oss:20b-cloud', 'nemotron-3-super'],
            'a local model that shares a free cloud name must stay local'
        );
        assert.deepEqual(
            sections['PAID CLOUD MODELS'],
            ['glm-4.7:cloud', 'minimax-m2.1:cloud']
        );

        const counts = await page.$$eval('#model-list .model-group-count', (elements) =>
            elements.map((element) => element.textContent)
        );
        assert.deepEqual(counts, ['2', '2', '2']);

        await page.click('#model-selector-btn');
        await page.click('#sort-az');

        const sorted = await readSections();
        assert.deepEqual(
            Object.keys(sorted),
            ['LOCAL MODELS', 'FREE CLOUD MODELS', 'PAID CLOUD MODELS'],
            'A-Z sorting must not merge the sections'
        );
        assert.deepEqual(
            sorted['FREE CLOUD MODELS'],
            ['gpt-oss:20b-cloud', 'nemotron-3-super']
        );
        assert.deepEqual(
            sorted['PAID CLOUD MODELS'],
            ['glm-4.7:cloud', 'minimax-m2.1:cloud']
        );
    } finally {
        await context.close();
    }
});

test('the empty state explains the selected cloud model plan', async () => {
    server.state.models = [];

    const { context, page } = await openApp(browser, port, {
        cloudModels: JSON.stringify(['gemma4:31b', 'glm-4.7:cloud']),
        lastModel: 'gemma4:31b'
    });

    try {
        await page.waitForSelector('.model-plan-note.free');
        assert.match(
            (await page.textContent('.model-plan-note')).trim(),
            /Free cloud model/
        );

        await page.click('#model-selector-btn');
        await page.click('#model-list .model-option:has-text("glm-4.7:cloud")');
        await page.waitForFunction(() => state.currentModel === 'glm-4.7:cloud');

        await page.waitForSelector('.model-plan-note.paid');
        const paidNote = (await page.textContent('.model-plan-note')).trim();
        assert.match(paidNote, /Paid cloud model/);
        assert.match(paidNote, /paid plan or usage credits/);
        assert.equal(
            await page.getAttribute('.model-plan-note a', 'href'),
            'https://ollama.com/settings'
        );
    } finally {
        await context.close();
    }
});

test('quality label follows the preset and think is gated by model support', async () => {
    server.state.models = ['gpt-oss:20b', 'gemma3:4b'];

    const { context, page } = await openApp(browser, port);

    try {
        assert.equal(await page.evaluate(() => state.currentModel), 'gpt-oss:20b');

        await page.click('#quality-selector-btn');
        await page.click('#quality-dropdown .model-option:has-text("High Reasoning")');
        assert.equal((await page.textContent('#current-quality-name')).trim(), 'High');

        await sendMessage(page, 'thinking model');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        const thinkingRequest = server.state.requests.at(-1);
        assert.equal(thinkingRequest.model, 'gpt-oss:20b');
        assert.equal(thinkingRequest.think, 'high');

        await page.click('#model-selector-btn');
        await page.click('#model-list .model-option:has-text("gemma3:4b")');
        await page.waitForFunction(() => state.currentModel === 'gemma3:4b');
        assert.equal(
            await page.evaluate(() => getComputedStyle(document.getElementById('quality-selector-btn')).display),
            'none',
            'the reasoning controls should be hidden for a non-thinking model'
        );

        await page.click('#header-new-chat-btn');
        await sendMessage(page, 'plain model');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        const plainRequest = server.state.requests.at(-1);
        assert.equal(plainRequest.model, 'gemma3:4b');
        assert.equal('think' in plainRequest, false, 'think must not be sent to unsupported models');
    } finally {
        await context.close();
    }
});

test('the non-functional web-search control and payload are removed', async () => {
    server.state.models = ['gpt-oss:20b'];

    const { context, page } = await openApp(browser, port, { enableSearch: 'true' });

    try {
        assert.equal(await page.$('#search-btn'), null, 'the search toggle should not exist');
        assert.equal(
            await page.evaluate(() => document.getElementById('header-controls').textContent.includes('🌐')),
            false
        );

        await sendMessage(page, 'no web search');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('from the mock.'),
            null,
            { timeout: 10000 }
        );

        const request = server.state.requests.at(-1);
        assert.equal('options' in request, false);
        assert.equal(JSON.stringify(request).includes('web_search'), false);
    } finally {
        await context.close();
    }
});

test('remote network failures explain the cloud CORS limitation', async () => {
    server.state.models = ['local-model:latest'];

    const { context, page } = await openApp(browser, port, {
        cloudUrl: 'http://example.invalid/api',
        cloudModels: JSON.stringify(['remote-model:cloud'])
    });

    try {
        await page.click('#model-selector-btn');
        await page.click('#model-list .model-option:has-text("remote-model:cloud")');
        await page.waitForFunction(() => state.currentModel === 'remote-model:cloud');

        await sendMessage(page, 'cloud hello');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('CORS'),
            null,
            { timeout: 15000 }
        );

        const text = await page.textContent('#messages-area');
        assert.match(text, /ollama\.com does not send CORS headers/);
        assert.match(text, /same-origin proxy/);
        assert.equal(server.state.requests.length, 0, 'the failing cloud request should not reach the mock server');
    } finally {
        await context.close();
    }
});

test('API keys are refused on insecure remote endpoints', async () => {
    server.state.models = ['local-model:latest'];

    const { context, page } = await openApp(browser, port, {
        cloudUrl: 'http://example.invalid/api',
        cloudApiKey: 'sk-test-secret',
        cloudModels: JSON.stringify(['remote-model:cloud'])
    });

    try {
        await page.click('#model-selector-btn');
        await page.click('#model-list .model-option:has-text("remote-model:cloud")');

        await sendMessage(page, 'send a secret');
        await page.waitForFunction(
            () => document.getElementById('messages-area').textContent.includes('Refusing to send the API key'),
            null,
            { timeout: 15000 }
        );

        assert.equal(server.state.requests.length, 0);
        assert.equal(
            await page.$$eval('#messages-area .chat-error', (elements) => elements.length),
            1,
            'the error bubble should remain visible even without streamed tokens'
        );
        assert.equal(await page.evaluate(() => state.isSending), false);
        assert.equal(
            (await page.textContent('#messages-area')).includes('sk-test-secret'),
            false,
            'the API key must never be rendered'
        );
    } finally {
        await context.close();
    }
});

test('settings reject malformed endpoints and keep the dialog open', async () => {
    server.state.models = ['local-model:latest'];

    const { context, page } = await openApp(browser, port);
    const dialogs = [];
    page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
    });

    try {
        await page.click('#settings-btn-sidebar');
        await page.waitForSelector('#settings-panel.active');
        await page.fill('#setting-local-url', 'javascript:alert(1)');
        await page.click('#save-settings-btn');

        await page.waitForFunction(() => document.getElementById('settings-panel').classList.contains('active'));
        assert.ok(
            dialogs.some((message) => message.includes('valid http:// or https:// URLs')),
            'an invalid endpoint should be rejected'
        );
        assert.match(await page.evaluate(() => state.localUrl), /^http:\/\/127\.0\.0\.1:/);
    } finally {
        await context.close();
    }
});

test('corrupted persisted settings cannot break app startup', async () => {
    server.state.models = ['good-model:latest-cloud'];
    const { context, page, pageErrors } = await openApp(browser, port, {
        hiddenModels: '{not-json',
        cloudModels: '"not-an-array"',
        qualityPreset: 'ultra',
        sortOrder: 'sideways',
        fontSize: 'gigantic',
        sidebarWidth: 'calc(100vw)'
    });

    try {
        assert.equal(pageErrors.length, 0);

        const names = await page.$$eval('#model-list .model-option .model-name', (elements) =>
            elements.map((element) => element.textContent)
        );
        assert.ok(names.includes('good-model:latest-cloud'), 'the malformed hidden list should fall back to empty');

        const validated = await page.evaluate(() => ({
            qualityPreset: state.qualityPreset,
            sortOrder: state.sortOrder,
            fontSize: state.fontSize,
            sidebarWidth: state.sidebarWidth,
            hiddenModels: state.hiddenModels,
            cloudModels: state.cloudModels.length
        }));

        assert.equal(validated.qualityPreset, 'none');
        assert.equal(validated.sortOrder, 'default');
        assert.equal(validated.fontSize, 'medium');
        assert.equal(validated.sidebarWidth, '280px');
        assert.deepEqual(validated.hiddenModels, []);
        assert.ok(validated.cloudModels > 0, 'default cloud models should be restored');

        assert.equal(await page.evaluate(() => document.getElementById('sidebar').style.width), '280px');
        assert.equal(
            await page.evaluate(() => getComputedStyle(document.documentElement).fontSize),
            '15px'
        );

        await page.click('#settings-btn-sidebar');
        await page.waitForSelector('#settings-panel.active');
        const cloudCount = await page.$$eval('#cloud-model-list .model-list-item', (items) => items.length);
        assert.ok(cloudCount > 0);
    } finally {
        await context.close();
    }
});
