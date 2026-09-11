# Shift Board — dashboard

The front-end for Shift Board, a live attendance dashboard for
Firstmac Operations Center PTY LTD-Philippine Branch, built on the Sprout HR API.

This repo holds **only the page**. All the logic, credentials and data live in a
separate Google Apps Script project, which this page calls at runtime.

## Why it's hosted rather than opened as a file

Apps Script rejects requests from pages opened directly from disk — a
double-clicked file reports its origin as `null`. The page has to be served
over http(s) to have a real origin, which is what this deployment is for.

## Setup

On first load the page asks for the Apps Script Web App URL (ending in
`/exec`). That's saved in the browser's localStorage, per browser — it is
never committed to this repo and never leaves the machine it's entered on.

Then sign in with your Sprout System ID. Only System IDs on the Apps Script
project's `ADMIN_ALLOWLIST` can register.

## Updating

Replace `index.html` and commit. Vercel redeploys automatically.

## What is NOT in here

No Sprout credentials, no API keys, no access tokens. The only URL hardcoded
in `index.html` is a placeholder. Keep it that way — if you ever find yourself
pasting a real credential into this file, it belongs in the Apps Script
project's Script Properties instead.
