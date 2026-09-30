<p align="center">
  <img src="assets/logo.png" alt="700 AI" width="420">
</p>

<p align="center">
  <em>A local AI assistant for your terminal. Any provider, your keys, your machine.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Proprietary-e74c3c" alt="License: Proprietary">
  <img src="https://img.shields.io/badge/version-2.0.0-e67e22" alt="Version 2.0.0">
  <img src="https://img.shields.io/badge/node-%3E%3D18-3c873a" alt="Node >= 18">
</p>

---

700 AI is a provider-agnostic chat + build REPL. It talks to OpenAI, Anthropic,
OpenRouter, Groq, Mistral, Together, Ollama, or any OpenAI-compatible endpoint —
using **your** API key, stored only on your machine in `~/.700ai`. Nothing you
type leaves your computer except the API calls you make to your chosen provider.

<p align="center">
  <img src="assets/screenshot.png" alt="700 AI terminal" width="720">
</p>

## What's new in 2.0

The **Multimodal & Reasoning Overhaul** turns the REPL into a multimodal
developer environment:

- **Multimodal ingestion** — `/stage <file>` accepts audio, video, PDFs/Office
  docs, code, archives and arbitrary binaries. Type is confirmed by **magic
  bytes** (never the extension), metadata is harvested (durations, resolutions,
  page counts, token counts, import summaries, SHA-256), and a preview is
  injected into your prompts. Validation runs on a **background worker thread**,
  so the input line never blocks and unchanged files are served from cache.
- **Reasoning acceleration** — optional **speculative routing** (`/route`) sends
  simple asks to a fast model and keeps complex, multi-step work on the primary
  model, with chain-of-thought scaffolding applied automatically.
- **Live state animations** — five centered, low-flicker states (`thinking`,
  `thinking-deeper`, `running`, `connecting`, `paused`); preview them with
  `/states`.
- **Self-healing diagnostics** — failures render as structured **DIAGNOSTIC
  FAILURE REPORT** boxes with a cause and numbered remediation steps instead of
  raw stack traces. Network calls retry with exponential backoff.
- **Rich typography** — model output is laid out with headers, syntax-
  highlighted code blocks, callouts and emphasis.
- **One-command deploy** — `/deploy` stages, writes a semantic commit, and
  pushes to GitHub using a classic token from `GITHUB_PAT` (never stored).

## Requirements

- Node.js **18 or newer**
- **ffmpeg** (optional) — enables full audio/video metadata and keyframe/waveform
  sampling. Without it, native header parsers still report core fields.

## Install

Clone the repo and install dependencies:

```bash
gh repo clone Mcalrifle789/700-AI      # with the GitHub CLI
# or:
git clone https://github.com/Mcalrifle789/700-AI.git

cd 700-AI
npm install
```

Optionally install the global `700` command so you can run it from anywhere:

```bash
npm link
```

## Launch

```bash
700 start        # start the interactive terminal   (or: npm start)
700 setup        # open the guided setup wizard
```

> **PowerShell note:** PowerShell won't run a command that starts with a digit
> (it parses `700` as a number). Use the alphabetic alias instead:
>
> ```powershell
> ai700 start      # same command, PowerShell-safe   (or: & 700 start)
> ```
>
> `cmd.exe` and Git Bash accept `700 start` directly.

On launch the terminal fills with the engraved 700 AI splash.

Then, inside the REPL, list everything you can do:

```
700 ❯ /skills    # show all active skills / commands
```

## First-run setup

On first launch you'll be prompted to configure a provider. Run the guided
wizard any time with:

```bash
700 setup
```

It walks you through:

1. **Provider** — pick a preset (OpenAI, Anthropic, OpenRouter, Groq, Mistral,
   Together, Ollama, or a custom OpenAI-compatible URL).
2. **Model** — choose from the provider's **live model list**, fetched from its
   API (with manual entry as a fallback).
3. **Search** — an optional search provider for search-augmented skills.
4. **Images** — an optional image-generation model.

Your keys and settings are saved to `~/.700ai` with owner-only permissions.

## Commands

```bash
700 start        # start the interactive terminal (REPL)
700 setup        # run the guided setup wizard
700 --version    # print the version
700 --help       # show usage
```

Inside the REPL, **type `/`** to open a scrollable, type-to-filter list of every
command — or type a full command directly:

| Command      | What it does                                         |
| ------------ | ---------------------------------------------------- |
| `/skills`    | List all available commands                          |
| `/setup`     | Re-run setup / switch provider                       |
| `/model`     | Switch the active model (live list from your provider) |
| `/search`    | Web-search-augmented answer                          |
| `/build`     | Build an app/site in a live-reloading browser window |
| `/image`     | Generate an image from a prompt                      |
| `/stage`     | Stage a file (audio/video/doc/code/binary) as context |
| `/staged`    | List files staged into the session                  |
| `/unstage`   | Remove a staged file (index, name, or `all`)        |
| `/deploy`    | Commit & push the workspace to GitHub (classic token) |
| `/route`     | Configure speculative routing (fast model for simple asks) |
| `/states`    | Preview the five agent-state animations             |
| `/music`     | Connect Spotify or Apple Music                       |
| `/play`      | Play a song or playlist                              |
| `/playlists` | List and switch playlists                            |
| `/pause` `/next` `/prev` `/nowplaying` | Playback controls          |
| `/voice`     | Speak text aloud (requires the ElevenLabs plugin)    |
| `/agents`    | Create and manage custom `@name` agents              |
| `/plugins`   | Browse and install plugins                           |
| `/wallet`    | Your private earnings wallet                         |
| `/clear`     | Clear the conversation                               |
| `/exit`      | Quit                                                 |

Prompt skills like `/code`, `/review`, `/debug`, `/write`, `/summarize`,
`/translate`, `/plan`, and more steer the model for a specific task. You can
also route a message to a custom agent with `@name your message`.

## Music

Run `/music` to connect a service. Keys/tokens are stored only in `~/.700ai`.

- **Spotify** — create an app at
  [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard),
  add the redirect URI `http://127.0.0.1:8700/callback`, and paste your Client
  ID + Secret. 700 AI opens a browser once to authorize. `/play`, `/playlists`,
  `/pause`, `/next` then control playback on whatever Spotify device is already
  open. **Requires Spotify Premium** and an active device (the Web API controls
  playback; it doesn't stream audio into the terminal).
- **Apple Music** — needs an Apple Developer MusicKit key (Team ID + Key ID +
  `.p8`), or a pre-generated developer token. `/play` searches the Apple Music
  catalog and opens the track in the Apple Music app/web player.
  **Limitation:** your personal iCloud Music Library and native playback require
  a Music User Token, which Apple only issues via MusicKit in a browser/Apple
  device — so `/playlists` (your library) isn't available from the terminal.

## Voice (ElevenLabs)

The `/voice` command uses the bundled ElevenLabs plugin for text-to-speech.
It needs an ElevenLabs API key. Provide it via the environment:

```bash
export ELEVENLABS_API_KEY=your_key_here
700 start
```

Then in the REPL:

```
700 ❯ /voice hello from seven hundred
```

If `ELEVENLABS_API_KEY` isn't set, `/voice` will prompt you for a key and save
it to `~/.700ai` for next time. Synthesized audio plays via your system's
default media player.

## License

Proprietary — all rights reserved. See [`LICENSE`](LICENSE).
