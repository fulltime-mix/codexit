# Contributing

Thanks for taking a look at Codexit.

## Local Checks

Before opening a pull request, run:

```bash
npm run verify
```

For packaging changes, also run:

```bash
npm run build:dir
```

## Guidelines

- Keep the app lightweight: vanilla Electron, HTML, CSS, and JavaScript.
- Do not add telemetry or remote services.
- Do not commit generated app bundles, DMGs, `node_modules/`, logs, or local
  account data.
- Keep UI changes consistent with the restrained macOS utility style.
