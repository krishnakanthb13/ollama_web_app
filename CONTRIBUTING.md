# Contributing to Ollama Web App

Thank you for your interest in contributing! We want to keep this project lightweight, fast, and easy to use.

## How to Report Bugs
If you find a bug, please open an issue and include:
1.  **Browser & OS**: (e.g., Chrome 120 on Windows 11).
2.  **Ollama Version**: (run `ollama --version`).
3.  **Steps to Reproduce**: Clear steps to make the bug happen.
4.  **Console Errors**: Press F12 and share any red errors in the Console tab.

## How to Suggest Features
We prioritize **simplicity** and **performance**. Before suggesting a major new feature, ask:
- Does this require a backend server? (If yes, it likely won't be accepted).
- Does this require a build step? (If yes, rejected).
- Can this be done with vanilla JS/CSS?

## Development Workflow

1.  **Fork the Repository** on GitHub.
2.  **Clone your fork** locally:
    ```bash
    git clone https://github.com/krishnakanthb13/ollama_web_app.git
    ```
3.  **Run the App**:
    - Windows: Run `run_app.bat`
    - Linux/Mac: Run `./run_app.sh`
4.  **Make Changes**: Edit `index.html`, `js/app.js`, or `css/styles.css`.
5.  **Test**: Verified that:
    - [ ] Chats can be created and deleted.
    - [ ] Messages send and stream correctly.
    - [ ] Settings (Dark mode, models) persist after reload.
    - [ ] PWA installation works.
6.  **Push & PR**: Push changes to your branch and submit a Pull Request.

## Code Style
- **Indentation**: 4 spaces.
- **Quotes**: Single quotes `'` preferred in JS.
- **CSS**: Use CSS variables for colors (defined in `:root`).
- **No Dependencies**: Do not add npm packages unless absolutely necessary for dev tooling.

## License
By contributing, you agree that your code will be licensed under the GNU GPL v3.
