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
