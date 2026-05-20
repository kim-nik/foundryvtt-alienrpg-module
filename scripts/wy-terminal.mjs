/**
 * Weyland-Yutani Ship Terminal — FoundryVTT Module Entry Point
 * An interactive green-screen terminal interface for AlienRPG.
 */

import { WYTerminalApp } from './terminal-app.mjs';
import { ShipStatusManager } from './ship-status.mjs';
import { MuthurBridge } from './muthur-bridge.mjs';
import { MuthurEngine } from './muthur-engine.mjs';
import { registerSettings } from './settings.mjs';
import { TerminalSFX } from './terminal-sounds.mjs';
import { SHIP_PROFILES, getAvailableProfiles } from './ship-profiles.mjs';

/* ──────────────────────────────────────────────────────────────────
   Module Initialization
   ────────────────────────────────────────────────────────────────── */

let terminalApp = null;
let shipStatus = null;

Hooks.once('init', () => {
  console.log('WY-Terminal | Initializing Weyland-Yutani Ship Terminal');

  // Register module settings
  registerSettings();

  // Register Handlebars helpers needed for the terminal
  _registerHandlebarsHelpers();

  // Pre-load templates
  loadTemplates([
    'modules/wy-terminal/templates/terminal.hbs',
    'modules/wy-terminal/templates/views/boot.hbs',
    'modules/wy-terminal/templates/views/status.hbs',
    'modules/wy-terminal/templates/views/crew.hbs',
    'modules/wy-terminal/templates/views/systems.hbs',
    'modules/wy-terminal/templates/views/logs.hbs',
    'modules/wy-terminal/templates/views/muthur.hbs',
    'modules/wy-terminal/templates/views/scenes.hbs',
    'modules/wy-terminal/templates/views/starsystems.hbs',
    'modules/wy-terminal/templates/views/emergency.hbs',
    'modules/wy-terminal/templates/views/nav.hbs',
    'modules/wy-terminal/templates/views/comms.hbs',
    'modules/wy-terminal/templates/views/cargo.hbs',
    'modules/wy-terminal/templates/views/settings.hbs',
  ]);
});

Hooks.once('ready', () => {
  console.log('WY-Terminal | Ready');

  // Initialize ship status manager
  shipStatus = new ShipStatusManager();

  // Initialize game clock anchor on first boot (GM only)
  if (game.user.isGM) {
    try {
      const anchor = game.settings.get('wy-terminal', 'gameClockRealAnchor');
      if (!anchor) {
        game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
        console.log('WY-Terminal | Game clock anchor initialized');
      }
    } catch (e) { /* settings not yet registered */ }
  }

  // Players ALWAYS get full-screen terminal display mode
  // GM gets normal Foundry UI with terminal as a pop-out
  const isTerminalDisplay = !game.user.isGM;
  console.log(`WY-Terminal | Display mode: ${isTerminalDisplay ? 'TERMINAL (full-screen)' : 'GM (normal)'}`);

  // Expose to global scope for macros / debugging
  game.wyTerminal = {
    open: openTerminal,
    close: closeTerminal,
    toggle: toggleTerminal,
    status: shipStatus,
    app: () => terminalApp,
    sendGmCommand: (cmd) => MuthurBridge.sendGmCommand(cmd),
    getPlugins: () => MuthurEngine.getAvailablePlugins(),
    MuthurEngine,
    isTerminalDisplay,
  };

  // Player clients: hide ALL Foundry UI chrome and go full-screen
  if (isTerminalDisplay) {
    console.log('WY-Terminal | Player display — hiding all Foundry UI, full-screen terminal');
    _enableTerminalDisplayMode();
  }

  // Auto-open the terminal
  console.log('WY-Terminal | Auto-opening terminal...');
  openTerminal();
});

/* ──────────────────────────────────────────────────────────────────
   Scene Controls — Add terminal button
   ────────────────────────────────────────────────────────────────── */

Hooks.on('getSceneControlButtons', (controls) => {
  console.log('WY-Terminal | getSceneControlButtons fired, controls type:', typeof controls, Array.isArray(controls));

  try {
    // FoundryVTT v13: controls may be an array or iterable
    // Try to find the token controls group (named 'token' or 'tokens')
    let tokenControls;
    if (Array.isArray(controls)) {
      tokenControls = controls.find(c => c.name === 'token' || c.name === 'tokens');
    } else if (controls instanceof Map) {
      tokenControls = controls.get('token') || controls.get('tokens');
    } else if (typeof controls === 'object') {
      // v13 may use a plain object or other structure
      tokenControls = controls.token || controls.tokens;
    }

    const toolDef = {
      name: 'wy-terminal',
      title: game.i18n.localize('WY_TERMINAL.title'),
      icon: 'fas fa-terminal',
      button: true,
      onClick: () => toggleTerminal(),
      onChange: () => toggleTerminal(),
    };

    if (tokenControls?.tools) {
      if (Array.isArray(tokenControls.tools)) {
        tokenControls.tools.push(toolDef);
      } else if (tokenControls.tools instanceof Map) {
        tokenControls.tools.set('wy-terminal', toolDef);
      }
      console.log('WY-Terminal | Added button to token controls');
    } else {
      // Fallback: add to first available control group
      const first = Array.isArray(controls) ? controls[0] : null;
      if (first?.tools) {
        if (Array.isArray(first.tools)) {
          first.tools.push(toolDef);
        } else if (first.tools instanceof Map) {
          first.tools.set('wy-terminal', toolDef);
        }
        console.log('WY-Terminal | Added button to first control group:', first.name);
      } else {
        console.warn('WY-Terminal | Could not find any control group. Controls:', controls);
        // Log the structure for debugging
        if (Array.isArray(controls)) {
          controls.forEach((c, i) => console.log(`  control[${i}]:`, c.name, typeof c.tools));
        }
      }
    }
  } catch (err) {
    console.error('WY-Terminal | Failed to add scene control button:', err);
  }
});

/* ──────────────────────────────────────────────────────────────────
   Terminal Display Mode — Full-screen takeover
   ────────────────────────────────────────────────────────────────── */

/**
 * Inject CSS to hide all Foundry UI elements and prepare for full-viewport terminal.
 * Only active when displayMode === 'terminal'.
 */
function _enableTerminalDisplayMode() {
  const style = document.createElement('style');
  style.id = 'wy-terminal-display-mode';
  style.textContent = `
    /* ═══════ TERMINAL DISPLAY MODE ═══════
       Hide ALL Foundry UI — only the terminal is visible */

    /* Core Foundry UI elements */
    #sidebar,
    #hotbar,
    #navigation,
    #controls,
    #players,
    #logo,
    #pause,
    #loading,
    #chat-controls,
    #camera-views,
    nav#scene-navigation,
    #ui-top,
    #ui-bottom,
    #ui-left,
    #ui-right,
    .notification-pip,
    #context-menu,
    .app:not(.wy-terminal-app) {
      display: none !important;
    }

    /* Hide the canvas — we render scenes inside the terminal */
    #board,
    #canvas {
      display: none !important;
    }

    /* Make body background match terminal */
    body {
      background: #0a0a0a !important;
      overflow: hidden !important;
    }

    /* Full-viewport terminal app */
    .wy-terminal-app {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      max-width: 100vw !important;
      max-height: 100vh !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      z-index: 9999 !important;
    }

    .wy-terminal-app .window-header {
      display: none !important;
    }

    .wy-terminal-app .window-content {
      width: 100% !important;
      height: 100% !important;
      padding: 0 !important;
      margin: 0 !important;
    }

    /* Hide the terminal close button — always hidden */
    .wy-header-close {
      display: none !important;
    }

    /* Enlarge nav buttons for touch on large displays */
    .wy-terminal .wy-nav-btn {
      min-height: 52px;
      font-size: 12px;
    }

    /* Terminal fills its container — no border/radius */
    .wy-terminal {
      border-radius: 0 !important;
      border: none !important;
    }
  `;
  document.head.appendChild(style);

  // Add display-mode class to body for additional CSS hooks
  document.body.classList.add('wy-terminal-display-mode');
}

/* ──────────────────────────────────────────────────────────────────
   Terminal Open / Close / Toggle
   ────────────────────────────────────────────────────────────────── */

function openTerminal() {
  if (terminalApp && terminalApp.rendered) {
    terminalApp.bringToTop();
    return terminalApp;
  }
  terminalApp = new WYTerminalApp({ shipStatus });
  terminalApp.render(true);
  return terminalApp;
}

function closeTerminal() {
  if (terminalApp) {
    terminalApp.close();
    terminalApp = null;
  }
}

function toggleTerminal() {
  if (terminalApp?.rendered) {
    closeTerminal();
  } else {
    openTerminal();
  }
}

/* ──────────────────────────────────────────────────────────────────
   Socket Handling — Sync status across clients
   ────────────────────────────────────────────────────────────────── */

Hooks.once('ready', () => {
  game.socket.on('module.wy-terminal', (data) => {
    if (data.type === 'statusUpdate' && shipStatus) {
      shipStatus.mergeRemoteUpdate(data.payload);
      if (terminalApp?.rendered) {
        terminalApp.refreshCurrentView();
      }
    }
    if (data.type === 'alert' && terminalApp?.rendered) {
      terminalApp.showAlert(data.payload.message);
    }
    if (data.type === 'sceneChange' && terminalApp?.rendered) {
      // GM pushed a scene change — switch terminal to that scene
      TerminalSFX.play('screenChange');
      terminalApp.activeSceneId = data.payload.sceneId;
      terminalApp._switchView('scenes');
    }
    if (data.type === 'refreshTokens' && terminalApp?.rendered) {
      // GM sent pre-computed token positions — apply them directly.
      // This avoids reading from local scene docs which may have stale data
      // if this socket message arrives before Foundry's own document sync.
      const { sceneId, tokens } = data.payload || {};
      if (terminalApp.activeView === 'scenes' &&
          sceneId && sceneId === terminalApp.activeSceneId) {
        if (tokens && tokens.length > 0) {
          // Use GM-authoritative positions (debounced internally)
          terminalApp.scheduleTokenUpdate(tokens);
        } else {
          // Fallback: no tokens in payload — read from local scene data after delay
          terminalApp.scheduleTokenUpdate(null);
        }
      }
    }
    // Player requests to move a token they can't directly update —
    // GM performs the update on their behalf
    if (data.type === 'moveToken' && game.user.isGM) {
      const { sceneId, tokenId, x, y } = data.payload || {};
      const scene = game.scenes?.get(sceneId);
      const tokenDoc = scene?.tokens?.get(tokenId);
      if (tokenDoc) {
        tokenDoc.update({ x: Math.round(x), y: Math.round(y) }).then(() => {
          console.log(`WY-Terminal | GM executed player-requested token move: ${tokenId}`);
        }).catch(err => {
          console.warn('WY-Terminal | Failed to execute player token move:', err);
        });
      }
    }
    if (data.type === 'shipSwitch' && terminalApp?.rendered) {
      // GM switched ship profile — full re-render to pick up new theme, nav, and data
      console.log(`WY-Terminal | Ship switched to ${data.payload.shipName} — refreshing terminal`);
      terminalApp.activeView = 'status';
      TerminalSFX.play('boot');
      terminalApp.render(true);
    }
    // Player requests clearance change — only GM writes the setting (per-user)
    if (data.type === 'setClearance' && game.user.isGM) {
      const level = data.payload?.level;
      const userId = data.payload?.userId;
      if (level && userId && WYTerminalApp.CLEARANCE_RANK?.[level] !== undefined) {
        const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
        if (levels[userId] !== level) {
          levels[userId] = level;
          game.settings.set('wy-terminal', 'userClearanceLevels', levels).then(() => {
            console.log(`WY-Terminal | Clearance for user ${userId} set to ${level}`);
            // Broadcast to all clients so the target user updates their footer
            game.socket.emit('module.wy-terminal', {
              type: 'clearanceUpdated',
              payload: { level, userId },
            });
            // Update GM's own terminal if open
            if (terminalApp?.rendered) {
              if (userId === game.user.id) {
                terminalApp._updateFooterClearance(level);
              }
              // Re-render GM's CMD CODE view to reflect updated user states
              if (terminalApp.activeView === 'commandcode') {
                terminalApp._renderView('commandcode');
              }
            }
          });
        }
      }
    }
    // Clearance was updated by GM — target user updates their footer and re-renders
    if (data.type === 'clearanceUpdated' && terminalApp?.rendered) {
      const { level, userId } = data.payload;
      // Only update footer if this clearance change is for the current user
      if (userId === game.user.id) {
        terminalApp._updateFooterClearance(level);
      }
      // Re-render current view (player sees updated access, GM sees updated user list)
      terminalApp._renderView(terminalApp.activeView);
    }
    // Player requests frequency change — only GM writes the setting
    if (data.type === 'setCommFrequency' && game.user.isGM) {
      const freq = data.payload?.frequency;
      if (freq && /^\d{3}\.\d{2}$/.test(freq)) {
        game.settings.set('wy-terminal', 'commFrequency', freq).then(() => {
          console.log(`WY-Terminal | Comm frequency set to ${freq} MHz (requested by player)`);
          // Broadcast refresh so all clients see the new frequency
          game.socket.emit('module.wy-terminal', {
            type: 'refreshView',
            payload: { view: 'comms' },
          });
        });
      }
    }
    // View refresh broadcast — re-render if currently on that view
    if (data.type === 'refreshView' && terminalApp?.rendered) {
      const view = data.payload?.view;
      if (view === 'all') {
        terminalApp.render(true);
      } else if (view && terminalApp.activeView === view) {
        terminalApp._renderView(view);
      }
    }
    // New log alert — flash the LOGS nav button for non-GM users
    if (data.type === 'newLogAlert' && terminalApp?.rendered && !game.user.isGM) {
      console.log('WY-Terminal | newLogAlert received — flashing LOGS button');
      const el = terminalApp.element[0] ?? terminalApp.element;
      const logsBtn = el?.querySelector('[data-view="logs"]');
      if (logsBtn && !logsBtn.classList.contains('wy-nav-flash')) {
        logsBtn.classList.add('wy-nav-flash');
        TerminalSFX.play('beep');
      }
    }
    // Emergency protocol activated — flash STATUS button, play alarm, show alert
    if (data.type === 'emergencyActivated' && terminalApp?.rendered) {
      const { protocol, message } = data.payload;
      console.log(`WY-Terminal | Emergency activated: ${protocol}`);

      // Show persistent alert
      terminalApp.showAlert(message, 0);

      // Play alarm sound on player terminals
      if (!game.user.isGM) {
        TerminalSFX.play('emergency');

        // Flash the STATUS nav button
        terminalApp._flashStatusButton();

        // Start computer voice warnings — repeating every 60 real seconds
        if (protocol === 'self-destruct') {
          // Self-destruct uses its own countdown-aware voice system
          terminalApp._startSelfDestructVoice();
        } else {
          // All other protocols: build spoken warning from alert message
          const voiceText = `WARNING. ${message}. ALL PERSONNEL RESPOND ACCORDINGLY.`;
          terminalApp._startEmergencyVoice(protocol, voiceText);
        }

        // Evacuation: also play alarm
        if (protocol === 'evacuate') {
          TerminalSFX.play('alert');
        }
      }

      // Refresh status and emergency views if currently viewing
      if (terminalApp.activeView === 'status') terminalApp._renderView('status');
      if (terminalApp.activeView === 'emergency') terminalApp._renderView('emergency');
    }
    // Emergency protocol cancelled — stop voice, clear flash if no emergencies remain
    if (data.type === 'emergencyCancelled' && terminalApp?.rendered) {
      const { protocol, anyRemaining } = data.payload;
      console.log(`WY-Terminal | Emergency cancelled: ${protocol}, anyRemaining: ${anyRemaining}`);

      if (!game.user.isGM) {
        // Stop voice warnings for the cancelled protocol
        if (protocol === 'self-destruct') {
          terminalApp._clearSelfDestructVoice();
          // Announce abort via voice
          terminalApp._speakWarning('ATTENTION. SELF-DESTRUCT SEQUENCE HAS BEEN ABORTED. RESUME NORMAL OPERATIONS.');
        } else {
          terminalApp._clearEmergencyVoice(protocol);
        }

        // Use GM-authoritative flag — local shipStatus may be stale
        if (!anyRemaining) {
          terminalApp._clearAllEmergencyVoices();
          const el = terminalApp.element?.[0] ?? terminalApp.element;
          el?.querySelector('[data-view="status"]')?.classList.remove('wy-nav-flash-red');
          terminalApp.hideAlert();
        }
      }

      // Refresh views
      if (terminalApp.activeView === 'status') terminalApp._renderView('status');
      if (terminalApp.activeView === 'emergency') terminalApp._renderView('emergency');
    }
    // GM commands are handled by MuthurEngine's own socket listener
    // (set up when the engine initializes inside MuthurBridge)
  });
});

/* ──────────────────────────────────────────────────────────────────
   Scene Hooks — Auto-sync when GM changes active scene or tokens
   ────────────────────────────────────────────────────────────────── */

// When a scene is activated (GM switches scenes), broadcast to display clients
Hooks.on('canvasReady', (canvas) => {
  if (game.user.isGM && canvas?.scene) {
    console.log('WY-Terminal | Scene activated:', canvas.scene.name);
    game.socket.emit('module.wy-terminal', {
      type: 'sceneChange',
      payload: { sceneId: canvas.scene.id },
    });
  }
  // If this IS the display client, also auto-switch
  if (game.wyTerminal?.isTerminalDisplay && terminalApp?.rendered) {
    terminalApp.activeSceneId = canvas?.scene?.id;
    if (terminalApp.activeView === 'scenes') {
      terminalApp._renderView('scenes');
    }
  }
});

// When tokens are created/updated/deleted, refresh the display
Hooks.on('createToken', (token) => {
  _broadcastTokenRefresh(token.parent);
});
Hooks.on('updateToken', (token, change) => {
  // Only broadcast when position or visibility changed (skip name edits, etc.)
  if ('x' in change || 'y' in change || 'hidden' in change ||
      'width' in change || 'height' in change || 'texture' in change ||
      'disposition' in change) {
    _broadcastTokenRefresh(token.parent);
  }
});
Hooks.on('deleteToken', (token) => {
  _broadcastTokenRefresh(token.parent);
});

function _broadcastTokenRefresh(scene) {
  if (!scene) return;

  // GM pre-computes token positions and sends them in the socket payload.
  // This means player clients get authoritative positions immediately
  // without needing to wait for Foundry's document sync to complete.
  if (game.user.isGM) {
    let tokens = [];
    if (terminalApp) {
      try {
        tokens = terminalApp._getSceneTokens(scene);
      } catch (err) {
        console.warn('WY-Terminal | Failed to compute token positions for socket:', err);
      }
    }
    game.socket.emit('module.wy-terminal', {
      type: 'refreshTokens',
      payload: { sceneId: scene.id, tokens },
    });
  }

  // Also refresh locally (GM's own terminal, or player hook backup).
  // Use debounced schedule to coalesce rapid successive updates.
  if (terminalApp?.rendered && terminalApp.activeView === 'scenes'
      && terminalApp.activeSceneId === scene.id) {
    terminalApp.scheduleTokenUpdate(null);
  }
}

/* ──────────────────────────────────────────────────────────────────
   Handlebars Helpers
   ────────────────────────────────────────────────────────────────── */

function _registerHandlebarsHelpers() {
  Handlebars.registerHelper('eq', function (a, b) {
    return a === b;
  });

  Handlebars.registerHelper('wyTimestamp', function () {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  });
}

/* ──────────────────────────────────────────────────────────────────
   Actor Sheet Injection — Ship Assignment Field
   ────────────────────────────────────────────────────────────────── */

/**
 * Inject a "Ship Assignment" dropdown into AlienRPG character/synthetic
 * actor sheets so the GM can assign crew to ships directly from the
 * Actor sidebar.  Works with both ApplicationV1 (jQuery) and V2 (HTMLElement).
 */
function _injectShipAssignment(app, html) {
  const actor = app.actor || app.document;
  if (!actor || (actor.type !== 'character' && actor.type !== 'synthetic')) return;
  if (!game.user.isGM) return;

  try {
    // Normalise to raw HTMLElement (v1 passes jQuery, v2 passes HTMLElement)
    const el = html instanceof HTMLElement ? html : (html[0] ?? html);
    if (!el || !(el instanceof HTMLElement)) return;

    // Guard against double-injection (re-render)
    if (el.querySelector('.wy-ship-assign-row')) return;

    const currentShip = actor.getFlag('wy-terminal', 'shipAssignment') || '';
    const profiles = getAvailableProfiles();

    const options = profiles.map(p =>
      `<option value="${p.id}"${p.id === currentShip ? ' selected' : ''}>${p.label}</option>`
    ).join('');

    const fieldHtml = `
      <div class="wy-ship-assign-row" style="
        display: flex; align-items: center; gap: 6px;
        padding: 4px 8px; margin: 4px 0;
        border: 1px solid rgba(58,122,0,0.3);
        background: rgba(0,10,0,0.3);
        font-family: 'Share Tech Mono', monospace;
        font-size: 12px; color: #3a7a00;
      ">
        <label style="flex-shrink:0; letter-spacing:1px; font-size:11px; color:#3a7a00;">⛴ SHIP ASSIGNMENT</label>
        <select class="wy-ship-assign-select" style="
          flex: 1; background: rgba(0,10,0,0.6); color: #3a7a00;
          border: 1px solid rgba(58,122,0,0.3); font-family: inherit;
          font-size: 12px; padding: 2px 4px; height: 26px;
        ">
          <option value=""${!currentShip ? ' selected' : ''}>— UNASSIGNED —</option>
          ${options}
        </select>
      </div>
    `;

    // Find injection point — try several selectors for AlienRPG / generic sheets
    const selectors = [
      '.header-fields',
      '.sheet-header',
      '.charheader',
      'header.sheet-header',
      '.window-content > form > header',
      '.window-content > form',
      '.sheet-body',
      '.window-content',
    ];

    let target = null;
    let insertMode = 'after'; // 'after' = insertAdjacentHTML afterend, 'prepend' = afterbegin
    for (const sel of selectors) {
      target = el.querySelector(sel);
      if (target) {
        // For form/body/window-content, prepend instead of after
        if (sel === '.window-content > form' || sel === '.sheet-body' || sel === '.window-content') {
          insertMode = 'prepend';
        }
        break;
      }
    }

    if (target) {
      target.insertAdjacentHTML(
        insertMode === 'prepend' ? 'afterbegin' : 'afterend',
        fieldHtml
      );
    } else {
      // Last resort: append to the element itself
      el.insertAdjacentHTML('afterbegin', fieldHtml);
    }

    // Bind change handler
    const select = el.querySelector('.wy-ship-assign-select');
    if (select) {
      select.addEventListener('change', async () => {
        const newVal = select.value;
        if (newVal) {
          await actor.setFlag('wy-terminal', 'shipAssignment', newVal);
        } else {
          await actor.unsetFlag('wy-terminal', 'shipAssignment');
        }
        const shipLabel = newVal ? (SHIP_PROFILES[newVal]?.name || newVal.toUpperCase()) : 'UNASSIGNED';
        ui.notifications.info(`WY-Terminal: ${actor.name} assigned to ${shipLabel}`);
      });
    }

    console.log(`WY-Terminal | Ship Assignment field injected for ${actor.name}`);
  } catch (err) {
    console.error('WY-Terminal | Failed to inject Ship Assignment field:', err);
  }
}

// Hook both v1 and v2 render patterns to cover all AlienRPG sheet versions
Hooks.on('renderActorSheet', (app, html, data) => _injectShipAssignment(app, html));
Hooks.on('renderDocumentSheet', (app, html) => {
  // Only fire for actor documents (avoid items, journals, etc.)
  const doc = app.actor || app.document;
  if (doc?.documentName === 'Actor') _injectShipAssignment(app, html);
});
