'use strict';

const { chromium } = require('playwright-core');

const CHROME_CHANNEL = process.env.CHROME_CHANNEL || 'chrome';

async function launchBrowser() {
    return chromium.launch({ channel: CHROME_CHANNEL, headless: true });
}

/**
 * Open the app in a fresh browser context with the mock Ollama endpoint
 * configured and the service worker disabled (so every run exercises the
 * current files, not a cached copy).
 */
async function openApp(browser, port, storage = {}, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({
        serviceWorkers: 'block',
        viewport
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.addInitScript(({ port, storage }) => {
        localStorage.setItem('localUrl', `http://127.0.0.1:${port}`);
        localStorage.setItem('cloudUrl', `http://127.0.0.1:${port}/api`);
        localStorage.setItem('cloudApiKey', '');
        for (const [key, value] of Object.entries(storage)) {
            localStorage.setItem(key, value);
        }
    }, { port, storage });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
        () => document.querySelectorAll('#model-list .model-option').length > 0,
        null,
        { timeout: 10000 }
    );

    return { context, page, pageErrors };
}

async function sendMessage(page, text) {
    await page.fill('#user-input', text);
    await page.click('#send-btn');
}

/**
 * Read the app's IndexedDB stores from inside the page. Each test gets a fresh
 * browser context, so the database only contains data created by that test.
 */
async function readDbSnapshot(page) {
    return page.evaluate(() => new Promise((resolve, reject) => {
        const open = indexedDB.open('OllamaWebApp');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction(['chats', 'messages'], 'readonly');
            const chatsRequest = tx.objectStore('chats').getAll();
            const messagesRequest = tx.objectStore('messages').getAll();

            tx.oncomplete = () => {
                db.close();
                resolve({
                    chats: chatsRequest.result,
                    messages: messagesRequest.result
                });
            };
            tx.onerror = () => reject(tx.error);
        };
    }));
}

module.exports = { launchBrowser, openApp, sendMessage, readDbSnapshot };
