# Privacy Policy (huashu-chrome)

[简体中文](PRIVACY.md) · [English](PRIVACY.en.md)

Last updated: 2026-08-26

## In one sentence

**huashu-chrome does not upload any of your data.** It operates between your own browser and your own computer, with no servers operated by us in between.

## Where your data goes

- The extension communicates with the bridge process over WebSocket. The bridge runs on **your own computer** and listens only on `127.0.0.1` (the local loopback address). All commands, page content, and screenshots travel only over this local connection, not over the internet.
- Audit logs, which record the operations performed by agents, are written only to **your own disk**. We cannot access or view them.
- We operate no servers and include no analytics SDKs, advertising, or tracking code.

## What we collect

We collect no data. There is no registration, telemetry, or usage reporting. All source code is available at [github.com/alchaincyf/huashu-chrome](https://github.com/alchaincyf/huashu-chrome), so anyone can audit the absence of data reporting.

## How sensitive information is handled

- Before writing logs to disk, the extension automatically redacts **credentials such as passwords, tokens, and 2FA recovery codes**, to reduce the risk of plaintext credentials appearing in audit logs.
- Your browser's login sessions, including cookies, remain in your browser. Agents use those sessions through the extension to operate pages; the login sessions themselves do not leave the browser.

## Your rights

- All data is on your computer. Removing the extension and local log files lets you delete all data.
- There is no account system, so there is no account-deletion process to complete.

## Contact

alchaincyf@gmail.com
