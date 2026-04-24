# Xodex Mobile

A small mobile web companion for local Codex sessions.

Run it on your Mac, open it from your phone, and keep Codex threads moving without using remote desktop. It talks to `codex app-server`, so it can list threads, resume a thread, send or steer a turn, show live output, show changed files, and answer approval prompts.

## Setup

Install the Codex app or CLI and make sure `codex` works in your terminal.

Install Tailscale on your Mac and phone from [tailscale.com](https://tailscale.com). It is free for personal use and gives your devices a private network, so your phone can open the Mac server without exposing it to the public internet.

Then run:

```bash
npm install
npm run dev
```

Open this from your phone:

```txt
http://YOUR-MAC-TAILSCALE-NAME:8787
```

If you want a simple extra lock, set a token before starting:

```bash
XODEX_ACCESS_TOKEN=change-me npm run dev
```

## Notes

Keep this on Tailscale or localhost. Do not expose it directly to the internet.

For production-style running:

```bash
npm run build
npm start
```

To check the project:

```bash
npm run check
```
