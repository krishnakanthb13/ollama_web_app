'use strict';

/*
 * A tiny static file server + mock Ollama API used by the browser tests.
 * It intentionally has no dependencies so `npm test` works after a plain
 * `npm install`.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json'
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function startNdjson(res, model) {
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive'
    });

    const write = (payload) => {
        if (res.writableEnded || res.destroyed) return false;
        res.write(JSON.stringify(payload) + '\n');
        return true;
    };

    return {
        chunk(message, done = false) {
            return write({ model, message, done });
        },
        end() {
            if (res.writableEnded || res.destroyed) return;
            res.end(JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true }) + '\n');
        }
    };
}

function createMockServer() {
    const state = {
        /** @type {Array<string | Record<string, unknown>>} model names or full /api/tags entries */
        models: ['good-model:latest-cloud'],
        /** @type {Array<Record<string, unknown>>} */
        requests: [],
        /** @type {((req: http.IncomingMessage, res: http.ServerResponse, body: any) => void | Promise<void>) | null} */
        chatHandler: null
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');

        try {
            if (url.pathname === '/api/tags' && req.method === 'GET') {
                return sendJson(res, 200, {
                    models: state.models.map((entry) => typeof entry === 'string'
                        ? { name: entry, modified_at: '2026-01-01T00:00:00Z' }
                        : { modified_at: '2026-01-01T00:00:00Z', ...entry })
                });
            }

            if (url.pathname === '/api/chat' && req.method === 'POST') {
                const body = await readJson(req);
                state.requests.push(body);
                if (state.chatHandler) {
                    return await state.chatHandler(req, res, body);
                }
                return defaultChat(res, body);
            }

            if (url.pathname.startsWith('/api/')) {
                return sendJson(res, 404, { error: 'unknown api route' });
            }

            return serveStatic(url.pathname, res);
        } catch (error) {
            if (!res.headersSent) {
                sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
            } else {
                res.end();
            }
        }
    });

    return {
        state,
        listen() {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    resolve(server.address().port);
                });
            });
        },
        close() {
            return new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            });
        }
    };
}

function defaultChat(res, body) {
    const stream = startNdjson(res, body.model);
    stream.chunk({ role: 'assistant', content: 'Hello ' });
    stream.chunk({ role: 'assistant', content: 'from the mock.' });
    stream.end();
}

function serveStatic(pathname, res) {
    const decoded = decodeURIComponent(pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = path.resolve(ROOT, relative);

    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        sendJson(res, 403, { error: 'forbidden' });
        return;
    }

    fs.readFile(filePath, (error, data) => {
        if (error) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(data);
    });
}

module.exports = { createMockServer, sleep, startNdjson };
