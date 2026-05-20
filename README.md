# Weyland-Yutani Ship Terminal

![WY-Terminal](images/image.png)

## Fork notes

This fork adds Russian localization support and small tooling changes to make future translation work easier. The module now registers `ru`, includes `lang/ru.json`, routes module settings and static terminal UI labels through Foundry i18n, and adjusts navigation buttons so longer Russian labels can wrap cleanly.

Translated so far: module settings, main terminal navigation, and many static UI labels in terminal views such as crew, cargo, logs, timers, navigation, game clock, emergency, science, weapons, and command code screens. Not translated yet: compendium packs, extracted world data, scenario/docs text, actor/journal/item content, and other campaign data.

A FoundryVTT module that turns a second screen, tablet, or touch monitor into a fully interactive shipboard computer terminal for the Alien RPG. Built for in-person games where you want to put a real Weyland-Yutani interface in front of your players and let them interact with the ship directly. Green phosphor CRT display, scanlines, flicker, the works.

This was built for running Chariot of the Gods but the architecture supports other Alien RPG scenarios through a plugin system.

https://github.com/user-attachments/assets/GM-Terminal-Demo.mp4

<video controls src="images/GM-Terminal-Demo.mp4" title="Terminal Demo"></video>

---

## What It Does

The GM runs FoundryVTT normally on their screen. Players get a dedicated terminal display that takes over their entire browser window. Everything syncs in real time over sockets.

**Player Terminal buttons:**

- **STATUS** -- Ship overview showing vessel info, hull integrity, and all system states at a glance.
- **CREW** -- Crew manifest pulled live from FoundryVTT Actor sheets with health, stress, attributes, skills, and conditions.
- **SYSTEMS** -- Detailed diagnostics for each ship system with power levels and status indicators.
- **LOGS** -- Ship log entries that the GM can drip-feed during play, gated by clearance level.
- **MAPS** -- Static reference maps with pinch-zoom and pan support for touch screens.
- **NAV** -- Navigation and stellar cartography display.
- **WEAPONS** -- Tactical weapons panel (Cronus only).
- **SCIENCE** -- Science and research systems (Cronus only).
- **MU/TH/UR** -- AI chat interface where players can ask the ship's computer questions and get in-character responses.
- **COMMS** -- Communications array frequency and status display.
- **CARGO** -- Full cargo manifest of everything aboard the ship.
- **SCHEMATICS** -- Renders FoundryVTT scenes as deck schematics with tokens, pinch-zoom, and pan.
- **CMD CODE** -- Numeric keypad for entering command codes that unlock higher clearance levels. Each player has a unique code and independent clearance state.

**GM-only buttons:**

- **GAME CLOCK** -- In-game time tracker that broadcasts to all player terminals.
- **EMERGENCY** -- Triggers emergency protocols (self-destruct, evacuation, lockdown, distress, atmosphere purge) with alarms and voice warnings on player terminals.
- **GM CONTROLS** -- Module settings, ship profile switching, crew folder filters, and terminal configuration.

---

## Installation

### Manifest URL (Recommended)

1. In FoundryVTT, go to **Add-on Modules** and click **Install Module**.
2. Paste this URL into the **Manifest URL** field at the bottom:

```
https://raw.githubusercontent.com/BenTheCloudGuy/foundryvtt-alienrpg-module/main/module.json
```

3. Click **Install**.
4. In your World, go to **Settings > Manage Modules** and enable **Weyland-Yutani Ship Terminal**.

### Manual Install

1. Download or clone this repository.
2. Copy the module folder into your FoundryVTT `Data/modules/` directory. The folder should be named `wy-terminal`.
3. Restart FoundryVTT.
4. Enable the module in **Settings > Manage Modules**.

### Requirements

- FoundryVTT v13 or later
- AlienRPG (Alien Evolved) game system v4.0.0 or later
- An OpenAI-compatible API for MU/TH/UR AI chat (optional -- the terminal works fine without it):
  - **OpenAI** -- Requires an API key and uses cloud-based models
  - **Local Ollama** -- Free, offline, runs on your own hardware. See [Local AI Setup](local-ai/README.md)

---

## Setup for In-Person Play

The intended setup is two screens: one for the GM running FoundryVTT normally, and one facing the players showing the terminal.

1. Open FoundryVTT and log in as GM on your main screen.
2. Open a second browser window (or on a second device/tablet) and log in as a Player.
3. The Player client automatically goes full-screen terminal mode -- no Foundry UI visible, just the green-screen interface.
4. The GM gets a movable pop-out terminal window that can be minimized, resized, and dragged around so you can still access FoundryVTT underneath.

### MU/TH/UR AI Setup

MU/TH/UR works with any OpenAI-compatible API. You can use OpenAI's cloud service or run a local LLM for free with no API key required.

#### Option A -- OpenAI (Cloud)

1. Get an API key from [platform.openai.com](https://platform.openai.com).
2. Open the terminal and click **GM CONTROLS**.
3. Set **API Base URL** to `https://api.openai.com/v1`.
4. Enter your API key.
5. Set **AI Model** to `gpt-4o-mini` (recommended) or `gpt-4o`.
6. Select a scenario plugin (montero, cronus, etc.).

#### Option B -- Local Ollama (Free / Offline)

Run a local LLM on your own machine. No API key, no cloud calls, no per-token costs.

1. Install [Ollama](https://ollama.com) and pull a model: `ollama pull llama3.1:8b`
2. Open the terminal and click **GM CONTROLS**.
3. Set **API Base URL** to `http://localhost:11434/v1`.
4. Leave **API Key** blank (Ollama needs no auth).
5. Set **AI Model** to `llama3.1:8b` (or whichever model you pulled).
6. Select a scenario plugin (montero, cronus, etc.).

For a Docker-based setup with GPU acceleration and Whisper speech-to-text, see the full guide: **[Local AI Setup](local-ai/README.md)**

#### No AI Configured

If no API endpoint is configured, MU/TH/UR falls back to **GM Relay** mode where player questions pop up on the GM screen and the GM types responses manually. The rest of the terminal works normally.

---

## GM Commands

These can be run from the browser console or Foundry macros:

```javascript
// Open/close/toggle the terminal
game.wyTerminal.open();
game.wyTerminal.close();
game.wyTerminal.toggle();

// Broadcast an alert to all player terminals
game.wyTerminal.sendGmCommand({ type: 'broadcast', message: 'HULL BREACH DETECTED', sound: 'horn' });

// Inject a scripted MU/TH/UR response
game.wyTerminal.sendGmCommand({ type: 'inject_response', message: 'ACCESS DENIED.' });

// Toggle a story flag (rebuilds the AI system prompt)
game.wyTerminal.sendGmCommand({ type: 'update_flag', flag: 'docked_with_cronus' });

// Switch scenario plugin mid-game
game.wyTerminal.sendGmCommand({ type: 'switch_plugin', plugin: 'cronus_life_support' });
```

---


## BUG ##
- If ACTOR Sheets are missing - CREW setting defaults to standand layout.. 
  - Need to package ACTORS with Module so they align with SHIP
  - Need to make sure ACTORs sheets are correct and upto date.



## Compatibility

- **FoundryVTT:** v13+
- **Game System:** AlienRPG (Alien Evolved) v4.0.0+
- **Browsers:** Chrome, Firefox, Edge, Safari (including mobile)
- **Touch Devices:** Full support for tablets and touch monitors

## To Do

- Custom wire art renderings of the ships to replace current maps (working on this with artists on Fiverr)
- Custom art for LOGS, such as scientific samples (working on this with artists on Fiverr)
- Custom log entries for Chariot of the Gods with video/gif animations
- Add support for speech-to-text so players can converse with MU/TH/UR via voice
- Create a custom agent for gameplay and use it for MU/TH/UR interactions, plus allow the GM to query the scenario and AlienRPG via Foundry chat -- should improve performance and reduce token costs

## Acknowledgments

Huge thanks to **ecattell** for creating [muthurGPT](https://github.com/ecattell/muthurGPT), which gave me the foundation and inspiration for this project. The MU/TH/UR terminal in this module is built on his work. I ported it from Python to JavaScript so it could run natively inside FoundryVTT, but the core idea and prompt architecture came from his project.

If you are running AlienRPG you should absolutely check it out. Even outside of FoundryVTT it makes a fantastic standalone prop. It runs perfectly on a Raspberry Pi 4 or newer.

<p align="center">
  <img src="images/retro_pc_01.jpg" alt="MU/TH/UR prop terminal" width="50%">
</p>

## License

This is an unofficial fan-made module and is not affiliated with, endorsed by, or associated with Free League Publishing or 20th Century Studios in any way. It was built by a fan for personal use while playing the Alien RPG tabletop roleplaying game.

Alien RPG is (c) Free League Publishing. The Alien franchise and Weyland-Yutani are properties of 20th Century Studios.
