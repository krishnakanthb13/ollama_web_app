# Release Notes - v0.0.1 (The "Polished PWA" Update)

This major release transforms the Ollama Web App from a simple interface into a robust, installable Progressive Web Application (PWA) with premium desktop features and enhanced chat management tools.

## 🚀 Key Features

### 💻 Progressive Web App (PWA) Support
- **Installable**: You can now install the app directly to your desktop via Chrome/Edge.
- **Offline Shell**: The app loads instantly even without an internet connection (thanks to the new Service Worker `sw.js`).
- **Standalone Window**: Runs in its own clean window, separate from browser tabs.

### 🎨 Modern UI/UX Overhaul
- **Desktop Window Mode**: On large screens (>1024px), the app now floats with a sleek border, shadow, and rounded corners (`20px` padding), giving it a premium "native app" feel.
- **Resizable Sidebar**: You can now drag the sidebar edge to resize it to your preference. Your choice is saved automatically.
- **Refined Typography**: Adjusted font sizes and added beautiful styling for Markdown headers in chat.
- **Themes**: Deep indigo accents on a dark background for reduced eye strain.

### 🗂️ Enhanced Chat Management
- **Markdown Export**: Download any chat thread as a formatted `.md` file, including metadata, user prompts, and AI responses. Perfect for archiving!
- **Chat Deletion**: Easily remove old conversations with the new trash icon.
- **Persistent State**: The app now remembers your sort order, last selected model, and font size preferences.

### 🧠 Advanced Model Capabilities
- **Capability Icons**: visual indicators in the model list for:
  - 🧠 **Thinking Models** (e.g., DeepSeek R1)
  - 🌐 **Web Search** (browsing capable models)
  - 🛠️ **Tool Use**
  - ⚡ **High Power** (large parameter models)
- **Cloud Model Management**: Add, remove, and manage custom cloud endpoints directly from the settings panel.

### 🛠️ Developer & Documentation
- **Unified Codebase**: PWA features are now integrated directly into the main root.
- **New Documentation**: Added `CODE_DOCUMENTATION.md`, `DESIGN_PHILOSOPHY.md`, and `CONTRIBUTING.md`.
- **Assets Organization**: Images and icons moved to a clean `assets/` directory.

## 🐛 Bug Fixes
- Fixed `toggleDropdown` errors.
- Resolved issues with model selection persistence.
- Fixed layout shifting on mobile devices.
- Corrected sidebar toggle visibility logic.

---

**Full Changelog**: https://github.com/krishnakanthb13/ollama_web_app
