# Design Philosophy

## The Problem
Interaction with local Large Language Models (LLMs) like Ollama is typically done via the CLI. While powerful, usage via terminal can be intimidating for casual users and lacks features like chat history, markdown rendering, and easy model switching. Existing web UIs often require complex build steps (Docker, Node.js, React apps) or are too heavy for simple usage.

## The Solution
**Ollama Web App** is designed to be the "Notepad" of AI interfaces: lightweight, instant, and reliable. It provides a premium, app-like experience without the bloat of modern web frameworks.

## Core Design Principles

### 1. Zero Build Step
- The project is written in **Vanilla HTML, CSS, and JavaScript**.
- No `npm build`, no Webpack, no Docker containers required to *run* the app.
- You can simply open the folder and run a static server. Accessing the code is accessible to anyone with basic web knowledge.

### 2. Local-First & Privacy-Centric
- **No Remote Server**: The app runs entirely in your browser.
- **Data Persistence**: All chat history is stored in **IndexedDB** inside your browser. No data is ever sent to a third-party server (unless you explicitly configure a Cloud Endpoint).
- **Direct Connection**: The app communicates directly from browser -> localhost:11434.

### 3. Progressive Web App (PWA)
- The app is designed to be installed on your desktop.
- It functions offline (the UI loads instantly).
- It breaks out of the browser tab to feel like a native tool.

### 4. Aesthetics Without Bloat
- We use modern CSS variables and flexbox/grid layouts.
- Themes (Dark Mode, Indigo Accents) are built-in without heavy UI libraries like Bootstrap or Tailwind.
- Animations are CSS-based for 60fps performance using `will-change`.

## Target Audience
- Developers who use Ollama and want a quick GUI.
- Users who want to chat with local models but don't want to manage Docker containers or Node.js backends.
- People who want a "private" ChatGPT experience running entirely on their own hardware.

## Trade-offs
- **Complexity Management**: By avoiding frameworks (React/Vue), `app.js` handles all DOM manipulation manually. This keeps the app fast but requires disciplined code organization.
- **Browser Security**: Browsers block direct access from `file://` protocol to APIs (due to CORS), which is why a simple local server (`http-server`) is used instead of just opening index.html.
