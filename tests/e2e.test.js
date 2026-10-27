'use strict';

const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');

const { createMockServer } = require('./mock-server.js');
const { launchBrowser, openApp, sendMessage } = require('./e2e-helpers.js');

let server;
let browser;
let port;

before(async () => {
    server = createMockServer();
    port = await server.listen();
    browser = await launchBrowser();
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
