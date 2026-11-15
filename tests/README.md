# Tests

These do not run on Cloudflare and are not part of the deployed app (only `public/` and `src/worker.js` are).

## Sync and sharing

    node --no-warnings tests/run.mjs

Needs Node 22.5 or newer (uses the built-in `node:sqlite`). No packages to install.
Runs the real `src/worker.js` and the real app script from `public/index.html` against an in-memory database with
simulated phones and locally signed sign-in tokens. Ends with `ALL PASSED: N checks`.

It is a simulation: it does not touch the real Cloudflare database or sign-in.

## Screens

    node tests/screens/home.js
    node tests/screens/tabs.js
    node tests/screens/budget.js
    node tests/screens/itinerary.js

Need Playwright with Chromium. Each opens the app in a headless browser with made-up data, prints a few facts
(page errors, sideways overflow, order of items) and saves screenshots to `tests/screens/out/` (not committed).
Look at the screenshots; nothing compares them automatically.
