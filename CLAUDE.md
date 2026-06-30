# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This repository is at the scaffolding stage. It currently contains only:

- `index.html` — a blank HTML5 document (empty `<body>`, placeholder `<title>`).
- `audio_analyzer.js` — an empty file (no code yet).
- `README.md` — one line: "関さんによるもの" (by Seki-san).

There is no build system, package manager, dependency manifest, or test setup. The page is plain static HTML/JS intended to be opened directly in a browser.

## Communication

- Respond to the user in Japanese by default (日本語で対応する).

## Conventions

- The project language is Japanese (`<html lang="jp">`, Japanese README). Keep user-facing text and comments consistent with that.
- `.gitattributes` enforces `* text=auto` (LF normalization). Let Git handle line endings; don't hardcode CRLF.

## Working in this repo

- To preview: open `index.html` directly in a browser, or serve the folder statically (e.g. `python -m http.server`).
- `audio_analyzer.js` is referenced by the repo name/file name as the intended feature (an audio analyzer GUI) but is not yet implemented or wired into `index.html`. When building it out, add the `<script src="audio_analyzer.js">` tag to `index.html`.
