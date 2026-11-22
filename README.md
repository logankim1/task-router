# Task Routing Operator

A full-stack task-routing operator console built in TypeScript with a Node/Express backend, SQLite (`better-sqlite3`) persistence, an injectable background routing worker, and a static HTML/JS operator UI.

Operators can create and submit tasks across expertise areas (`finance`, `healthcare`, `data analysis`, `operations`), inspect live routing progress and audit logs, intervene when routing stalls or needs manual handling, recover tasks after failures or restarts, and safely resolve state/epoch conflicts.

## How to Run It

Requires **Node.js 22** (tested across WSL, Linux, and macOS).

```bash
npm install
npm run dev
npm test