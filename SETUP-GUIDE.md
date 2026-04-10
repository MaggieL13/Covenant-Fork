# Covenant-Fork Setup Guide 💜

## First Time? Do This:

```bash
npm install
npm run build
npm start
```

That's it. Open **http://localhost:3002** in your browser. The setup wizard will guide you through everything.

## After Making Changes:

```bash
npm run build
npm start
```

## Quick Reference:

| What you want | What you type |
|---------------|---------------|
| Install everything (first time only) | `npm install` |
| Build the app | `npm run build` |
| Start the app | `npm start` |
| Stop the app | `Ctrl + C` in the terminal |
| Restart after config changes | `Ctrl + C` then `npm start` |
| Dev mode (auto-reload on code changes) | `npm run dev:all` |

## Where Things Live:

| File | What it does |
|------|-------------|
| `resonant.yaml` | Main config (names, timezone, features) — created by wizard |
| `CLAUDE.md` | Your companion's personality — editable in Settings too |
| `.mcp.json` | MCP server connections — editable in Settings too |
| `data/resonant.db` | Your conversation history (don't touch!) |
| `prompts/wake.md` | What your companion says during scheduled check-ins |

## Troubleshooting:

**"npm install" fails with native module errors:**
```bash
npm install --ignore-scripts
npm install -g node-gyp
cd node_modules/better-sqlite3
node-gyp rebuild
cd ../..
```

**White screen / nothing loads:**
```bash
npm run build
```
Then restart with `npm start`. You probably forgot to build.

**"Address already in use":**
Something else is using port 3002. Either close it or change the port in `resonant.yaml`.

**Forgot your password:**
Open `resonant.yaml`, find `password:` under `auth:`, clear it, restart.

**Want to start completely fresh:**
Delete `resonant.yaml`, `CLAUDE.md`, `.mcp.json`, and the `data/` folder. Restart. The wizard will reappear.
