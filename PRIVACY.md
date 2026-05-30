# Privacy

Codexit is designed as a local utility. It does not include analytics,
telemetry, crash reporting, or a separate backend service.

## What Is Stored Locally

- Account metadata is stored in Electron's app data directory.
- Account OAuth tokens are stored in the macOS Keychain under the Codexit
  service name.
- When switching accounts, Codexit writes the selected account into the local
  Codex auth file and the Codex Keychain entry so the Codex app can use it.

## Network Requests

Codexit makes network requests for:

- OpenAI OAuth login and token refresh.
- ChatGPT usage/quota lookup after an account is added or refreshed.

No account data is sent to any service operated by this project.

## Sensitive Data

Do not commit app data, Keychain exports, screenshots containing personal
emails, or generated build artifacts that may reveal local paths. The repository
ignore rules are set up to keep common generated files out of Git.

## Unofficial Project

Codexit is not affiliated with OpenAI. Names and service endpoints are used only
to make the local utility work with the user's own Codex setup.
