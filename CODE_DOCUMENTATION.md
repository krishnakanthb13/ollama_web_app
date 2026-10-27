# Code Documentation

## Project Structure

- `index.html`: The main entry point for the application. It bundles the UI structure and loads external dependencies via CDN.
- `css/`: Contains the styling for the application.
  - `styles.css`: The primary stylesheet containing CSS variables, dark mode themes, component styles, and responsiveness logic.
- `js/`: Contains the application logic.
  - `app.js`: The monolithic JavaScript file handling state, IndexedDB interactions, UI rendering, event listeners, and API calls to Ollama.
  - `utils.js`: Dependency-free shared helpers (HTML escaping, storage parsing, NDJSON parsing, URL normalisation). Loaded before `app.js` and also consumable by the Node test suite.
- `tests/`: Node-based unit tests (`node:test`) and headless-browser tests (Playwright Core against the installed Chrome channel), including a mock Ollama server.
- `sw.js`: The Service Worker file responsible for caching assets (HTML, CSS, JS, Images) to enable PWAs to work offline.
- `manifest.json`: Metadata for the Progressive Web App (PWA) installation.
- `run_app.bat` / `run_app.sh`: Scripts to launch a local development server for the application.

## High-Level Architecture

The Ollama Web App follows a **client-side only** architecture (Single Page Application). It connects directly to a locally running Ollama instance or a configured cloud endpoint.

1.  **UI Layer**: HTML5 + Vanilla CSS. No frameworks.
2.  **Logic Layer**: Vanilla JavaScript (ES6+).
3.  **Data Layer**: IndexedDB (`OllamaWebApp`) for persistent storage of chats and messages.
4.  **Network Layer**: `fetch` API to communicate with Ollama (`/api/tags`, `/api/chat`).

## Core Modules & Functions (`js/app.js`)

| Module / Class | Function | Description |
| :--- | :--- | :--- |
| **DB** | `constructor()` | Initializes the IndexedDB connection. |
| | `getChat(id)` | Retrieves a specific chat thread. |
| | `addMessage()` | Saves a user or assistant message to the database. |
| **State** | `state` object | Holds global app state (`currentChatId`, `models`, `settings`). |
| **Initialization** | `init()` | Bootstraps the app: binds DOM, loads models, restores settings. |
| **Chat Logic** | `sendMessage()` | Handles user input, updates UI, calls Ollama API, and streams response. |
| **Rendering** | `renderChatList()` | Renders the sidebar list of conversation history. |
| | `appendMessageToUI()` | Adds a new message bubble to the chat window (supports Markdown). |
| **Utilities** | `escapeHtml()` | Escapes all untrusted values before HTML interpolation. |
| **Settings** | `openSettings()` | Toggles the settings panel. |
| | `toggleCloudList()` | Expands/collapses the cloud model configuration section. |

## Data Flow

1.  **Initialization**: `init()` -> Load Settings (`localStorage`) -> Open DB -> Load Models (API) -> Render UI.
2.  **User Message**: Input -> `sendMessage()` -> **Update UI** (Optimistic) -> **Save to DB**.
3.  **API Call**: `sendMessage()` -> `fetch(Ollama API)` -> **Stream Response**.
4.  **Bot Response**: Chunk Received -> **Update UI** (Token by Token) -> **Save Final Message to DB**.

## Dependencies

- **Runtime**:
  - A modern web browser (Chrome, Edge, Firefox).
  - [Ollama](https://ollama.com/) running locally (default: `http://localhost:11434`) or cloud access.
- **Libraries (CDN)**:
  - `marked.min.js`: For parsing Markdown in chat messages.
  - `purify.min.js`: For sanitizing HTML to prevent XSS.
- **Development**:
  - `http-server`: Simple static server for local testing.

## Execution Flow

1.  User opens `index.html` (via `run_app.bat`).
2.  `sw.js` installs and caches core assets.
3.  `app.js` initializes `DB` and restores the last active chat/model.
4.  User types a prompt.
5.  App sends JSON payload to Ollama `/api/chat`.
6.  Ollama returns a stream of JSON objects.
7.  App parses chunks and updates the DOM in real-time.

## Testing

```bash
npm test          # unit + browser tests
npm run test:unit # node:test helpers only
npm run test:e2e  # headless Chrome against tests/mock-server.js
```

The browser tests use `playwright-core` with the locally installed Chrome
(`channel: "chrome"`), so no browser download is required. Set
`CHROME_CHANNEL=msedge` to run them with Edge instead.
