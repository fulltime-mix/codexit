# Codexit

Codexit is a small macOS Electron utility for managing multiple local Codex
ChatGPT accounts. It stores account credentials locally, shows quota status,
and switches the active Codex login by updating the local Codex auth bundle and
restarting the Codex app.

Codexit is unofficial and is not affiliated with OpenAI.

## Features

- Add or reauth ChatGPT accounts through an isolated OAuth window.
- Run quietly from the macOS menu bar, with the main window opened only on demand.
- Use the menu bar icon to view cached quota and switch accounts quickly.
- Store account tokens in the macOS Keychain.
- Show 5-hour and weekly usage windows when the usage endpoint is available.
- Switch the active Codex account and restart Codex from one place.
- Keep the UI local-first, with no analytics or external telemetry.

## Requirements

- macOS on Apple Silicon
- Node.js 20 or newer
- Codex installed in `/Applications/Codex.app` or available through macOS app lookup

## Development

```bash
npm install
npm start
```

Useful checks:

```bash
npm run lint
npm run smoke
npm run audit
npm run verify
```

Build a local macOS app directory:

```bash
npm run build:dir
```

Build a DMG:

```bash
npm run build
```

Build output is written to `release/` and is intentionally ignored by Git.

## Privacy

Codexit keeps account data on your Mac. It contacts OpenAI authentication and
ChatGPT usage endpoints only to complete login, refresh tokens, and read quota
status. See [PRIVACY.md](PRIVACY.md) for details.

## License

MIT. See [LICENSE](LICENSE).
