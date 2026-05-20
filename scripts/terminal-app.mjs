/**
 * WYTerminalApp — The main Foundry Application window for the Weyland-Yutani Terminal.
 * Manages all terminal views, navigation, display frame with pinch-zoom,
 * scene rendering, and MU/TH/UR chat integration.
 */

import { PinchZoomHandler } from './pinch-zoom.mjs';
import { MuthurBridge } from './muthur-bridge.mjs';
import { MuthurEngine } from './muthur-engine.mjs';
import { getShipProfile, getAvailableProfiles, SHIP_PROFILES } from './ship-profiles.mjs';
import { TerminalSFX } from './terminal-sounds.mjs';
import { localizeElement } from './localization.mjs';

/** Well-known ID for the permanent NAV ETA timer (cannot be deleted). */
const DEFAULT_NAV_ETA_ID = 'nav-eta-default';
/** Default ETA duration in game-clock ms (1 hour = 3 600 000 ms). */
const DEFAULT_NAV_ETA_MS = 60 * 60 * 1000;

export class WYTerminalApp extends Application {

  /** @type {import('./ship-status.mjs').ShipStatusManager} */
  shipStatus;

  /** @type {string} Current active view name */
  activeView = 'boot';

  /** @type {PinchZoomHandler|null} */
  zoomHandler = null;

  /** @type {MuthurBridge|null} */
  muthurBridge = null;

  /** @type {Array<{type: string, text: string}>} */
  chatHistory = [];

  /** @type {string|null} Active alert message */
  alertMessage = null;

  /** @type {string|null} Currently selected scene ID */
  activeSceneId = null;

  /** @type {string|null} Currently selected map ID */
  activeMapId = null;

  constructor(options = {}) {
    super(options);
    this.shipStatus = options.shipStatus;

    /** @type {Array} Cached log entries loaded from muthur/logs.json */
    this._fileLogCache = [];

    // Chat history starts empty — cleared on each send, no persistence needed
    this.chatHistory = [];

    /** @type {string|null} Last user query sent to MU/TH/UR AI (for resubmit after code entry) */
    this._lastMuthurQuery = null;

    // Load log entries from JSON file (async, fills cache before first view)
    this._loadFileLogEntries();
  }

  static get defaultOptions() {
    const w = 1200;
    const h = 800;
    try {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: 'wy-terminal',
        title: game.i18n.localize('WY_TERMINAL.title'),
        template: 'modules/wy-terminal/templates/terminal.hbs',
        width: game.settings.get('wy-terminal', 'terminalWidth') || w,
        height: game.settings.get('wy-terminal', 'terminalHeight') || h,
        classes: ['wy-terminal-app'],
        resizable: true,
        minimizable: true,
        popOut: true,
      });
    } catch {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: 'wy-terminal',
        title: game.i18n.localize('WY_TERMINAL.title'),
        template: 'modules/wy-terminal/templates/terminal.hbs',
        width: w,
        height: h,
        classes: ['wy-terminal-app'],
        resizable: true,
        minimizable: true,
        popOut: true,
      });
    }
  }

  /* ══════════════════════════════════════════════════════════════════
     DATA
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Get the active ship profile.
   */
  _getShipProfile() {
    const profileId = game.settings.get('wy-terminal', 'activeShip') || 'montero';
    return getShipProfile(profileId);
  }

  getData() {
    const profile = this._getShipProfile();
    const shipName = game.settings.get('wy-terminal', 'shipName');
    const shipClass = game.settings.get('wy-terminal', 'shipClass');

    // CRT effects — player terminals only, GM always clean
    const isGM = game.user.isGM;
    let scanlines = false, crtFlicker = false, scanlineOpacity = 0, flickerOpacity = 0;
    if (!isGM) {
      const rawScanlines = game.settings.get('wy-terminal', 'scanlines');
      const rawFlicker   = game.settings.get('wy-terminal', 'crtFlicker');
      const scanlineIntensity = (rawScanlines === true) ? 'medium' : (rawScanlines === false) ? 'off' : (rawScanlines || 'medium');
      const flickerIntensity  = (rawFlicker === true)   ? 'medium' : (rawFlicker === false)   ? 'off' : (rawFlicker || 'medium');
      scanlines  = scanlineIntensity !== 'off';
      crtFlicker = flickerIntensity  !== 'off';
      scanlineOpacity = { light: 0.3, medium: 0.6, heavy: 1.0 }[scanlineIntensity] || 0;
      flickerOpacity  = { light: 0.3, medium: 0.7, heavy: 1.0 }[flickerIntensity]  || 0;
    }
    const status = this.shipStatus?.getStatus() ?? {};

    const systemStatus = status.alert ? 'WARNING' : 'NOMINAL';
    const systemStatusClass = status.alert ? 'warning' : 'online';

    return {
      shipName,
      shipClass,
      shipRegistry: game.settings.get('wy-terminal', 'shipRegistry'),
      scanlines,
      crtFlicker,
      scanlineOpacity,
      flickerOpacity,
      systemStatus,
      systemStatusClass,
      activeView: this.activeView,
      currentDate: this._getGameDate(),
      alertActive: !!this.alertMessage,
      alertMessage: this.alertMessage || '',
      displayTitle: this._getDisplayTitle(),
      userName: game.user.name.toUpperCase(),
      muthurOnline: this._isMuthurAvailable(),
      isGM: game.user.isGM,
      activeClearance: this._getActiveClearance(),
      playerClearance: this._getPlayerClearance(),
      shipProfile: profile.id,
      uiTheme: profile.uiTheme,
      interfaceVersion: profile.interfaceVersion,
      extraNavButtons: profile.extraNavButtons || [],
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     RENDER & LIFECYCLE
     ══════════════════════════════════════════════════════════════════ */

  activateListeners(html) {
    super.activateListeners(html);
    const el = html[0] ?? html;

    localizeElement(el);

    // Add GM-specific class so the window header is visible for minimize/close
    if (game.user.isGM) {
      this.element[0]?.classList.add('wy-gm-terminal');
    }

    // Preload sounds for player clients
    TerminalSFX.preload();

    // Navigation buttons
    el.querySelectorAll('[data-view]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const view = e.currentTarget.dataset.view;
        TerminalSFX.play('beep');
        this._switchView(view);
      });
      // Touch support
      btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        const view = e.currentTarget.dataset.view;
        this._switchView(view);
      });
    });

    // Zoom buttons — use per-scene zoom when in schematics, fallback to global
    el.querySelector('[data-action="zoom-in"]')?.addEventListener('click', () => (this._sceneZoom || this.zoomHandler)?.zoomIn());
    el.querySelector('[data-action="zoom-out"]')?.addEventListener('click', () => (this._sceneZoom || this.zoomHandler)?.zoomOut());
    el.querySelector('[data-action="zoom-reset"]')?.addEventListener('click', () => (this._sceneZoom || this.zoomHandler)?.reset());

    // Initialize pinch-zoom on the display frame (disabled until scenes view)
    const displayFrame = el.querySelector('#wy-display-frame');
    const displayContent = el.querySelector('#wy-display-content');
    if (displayFrame && displayContent) {
      this.zoomHandler = new PinchZoomHandler(displayFrame, displayContent);
      this.zoomHandler.enabled = false; // Only enabled for Ship Schematics view
    }

    // Preload star systems database
    this._loadStarSystemsData();

    // Start event timer tick (GM only — checks every 10 real seconds)
    this._startEventTimerTick();

    // Render initial view
    this._renderView(this.activeView);
  }

  close(options) {
    // Prevent closing for player clients — terminal is always on
    if (!game.user.isGM) {
      console.log('WY-Terminal | Terminal cannot be closed on player display');
      return;
    }
    // GM can close for debugging
    if (this.zoomHandler) {
      this.zoomHandler.destroy();
      this.zoomHandler = null;
    }
    if (this.muthurBridge) {
      this.muthurBridge.destroy();
      this.muthurBridge = null;
    }
    return super.close(options);
  }

  /* ══════════════════════════════════════════════════════════════════
     VIEW MANAGEMENT
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Switch to a different terminal view.
   * @param {string} viewName
   */
  _switchView(viewName) {
    this.activeView = viewName;

    // Clean up clock interval when leaving gameclock view
    this._clearClockInterval();
    // Clean up self-destruct countdown interval when leaving status view
    this._clearSelfDestructInterval();
    // Clean up nav ETA countdown when leaving nav view
    if (this._navEtaInterval) {
      clearInterval(this._navEtaInterval);
      this._navEtaInterval = null;
    }
    // Clean up audio playback when leaving logs view
    if (this._activeAudioCleanup) {
      this._activeAudioCleanup();
      this._activeAudioCleanup = null;
    }

    // Clear new-log flash when navigating to logs
    if (viewName === 'logs') {
      const el = this.element[0] ?? this.element;
      el.querySelector('[data-view="logs"]')?.classList.remove('wy-nav-flash');
    }

    // Clear emergency flash when navigating to status
    if (viewName === 'status') {
      const el = this.element[0] ?? this.element;
      el.querySelector('[data-view="status"]')?.classList.remove('wy-nav-flash-red');
    }

    // Update button active states
    const el = this.element[0] ?? this.element;
    el.querySelectorAll('[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    // Update display title
    const titleEl = el.querySelector('#wy-display-title');
    if (titleEl) titleEl.textContent = this._getDisplayTitle();

    // Only show zoom controls on scenes (ship schematics) view with an active scene
    const zoomControls = el.querySelector('#wy-zoom-controls');
    const isSchematicsView = viewName === 'scenes' && (game.user.isGM || this.activeSceneId);
    if (isSchematicsView) {
      if (zoomControls) zoomControls.style.display = '';
      // Per-scene zoom is created in _setupScenesView; global zoom stays disabled
    } else {
      if (zoomControls) zoomControls.style.display = 'none';
      if (this.zoomHandler) {
        this.zoomHandler.enabled = false;
        this.zoomHandler.reset();
      }
      // Clean up per-scene zoom when leaving schematics
      if (this._sceneZoom) {
        this._sceneZoom.destroy();
        this._sceneZoom = null;
      }
      if (this._sceneResizeObserver) {
        this._sceneResizeObserver.disconnect();
        this._sceneResizeObserver = null;
      }
    }

    // Screen-change sound for player terminal
    TerminalSFX.play('screenChange');

    this._renderView(viewName);
  }

  /**
   * Render a specific view into the display frame.
   * @param {string} viewName
   */
  async _renderView(viewName) {
    const contentEl = this.element[0]?.querySelector('#wy-display-content')
      ?? this.element?.find?.('#wy-display-content')?.[0];
    if (!contentEl) return;

    const templatePath = `modules/wy-terminal/templates/views/${viewName}.hbs`;
    const data = this._getViewData(viewName);

    try {
      const rendered = await renderTemplate(templatePath, data);
      contentEl.innerHTML = rendered;
      localizeElement(contentEl);

      // Toggle full-height mode for views that need it (muthur chat)
      const displayFrame = contentEl.closest('#wy-display-frame') ?? contentEl.parentElement;
      if (displayFrame) {
        displayFrame.classList.toggle('wy-fullheight-view', viewName === 'muthur');
      }

      // Post-render hooks per view
      this._onViewRendered(viewName, contentEl);
    } catch (err) {
      console.error(`WY-Terminal | Failed to render view "${viewName}":`, err);
      contentEl.innerHTML = `<div style="padding: 20px; color: var(--wy-red); letter-spacing: 2px;">ERROR: VIEW "${viewName.toUpperCase()}" NOT FOUND</div>`;
    }
  }

  /**
   * Refresh current view without changing it.
   */
  refreshCurrentView() {
    this._renderView(this.activeView);
  }

  /**
   * Show an alert in the alert bar.
   * @param {string} message
   * @param {number} duration - Duration in ms (0 = persistent)
   */
  showAlert(message, duration = 10000) {
    // Alert klaxon for player terminal
    TerminalSFX.play('alert');

    this.alertMessage = message;
    const el = this.element[0] ?? this.element;
    const bar = el?.querySelector('.wy-alert-bar');
    if (bar) {
      bar.textContent = `⚠ ${message} ⚠`;
      bar.classList.add('active');
    }
    if (duration > 0) {
      setTimeout(() => this.hideAlert(), duration);
    }
  }

  hideAlert() {
    this.alertMessage = null;
    const el = this.element[0] ?? this.element;
    const bar = el?.querySelector('.wy-alert-bar');
    if (bar) bar.classList.remove('active');
  }

  /**
   * Show a clearance overlay banner inside the display content area.
   * Displays for 5 seconds, then fades out and removes itself.
   * @param {string} title   - e.g. 'ACCESS DENIED' or 'ACCESS GRANTED'
   * @param {string} detail  - e.g. 'REQUIRES CORPORATE CLEARANCE OR HIGHER'
   * @param {object} [opts]
   * @param {string} [opts.currentClearance] - Current clearance level to display
   * @param {boolean} [opts.granted=false]   - If true, shows green (granted) styling
   */
  _showClearanceOverlay(title, detail, opts = {}) {
    const { currentClearance, granted = false } = opts;
    const contentEl = this.element[0]?.querySelector('#wy-display-content')
      ?? this.element?.find?.('#wy-display-content')?.[0];
    if (!contentEl) return;

    // Remove any existing overlay first
    contentEl.querySelector('.wy-clearance-overlay')?.remove();

    const overlayClass = granted ? 'wy-clearance-granted' : 'wy-clearance-denied';
    const icon = granted ? '\u2714' : '\u26A0';
    const currentLine = currentClearance != null
      ? `CURRENT CLEARANCE: ${currentClearance || 'CREWMEMBER'}`
      : '';

    const overlay = document.createElement('div');
    overlay.className = `wy-clearance-overlay ${overlayClass}`;
    overlay.innerHTML = `
      <div class="wy-clearance-overlay-icon">${icon}</div>
      <div class="wy-clearance-overlay-title">${title}</div>
      <div class="wy-clearance-overlay-detail">${detail}</div>
      ${currentLine ? `<div class="wy-clearance-overlay-current">${currentLine}</div>` : ''}
    `;
    contentEl.prepend(overlay);

    // Play denied sound
    if (!granted) TerminalSFX.play('buzz');

    // Auto-remove after 5 seconds
    setTimeout(() => {
      overlay.classList.add('wy-clearance-overlay-fade');
      overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    }, 5000);
  }

  /* ══════════════════════════════════════════════════════════════════
     VIEW DATA PROVIDERS
     ══════════════════════════════════════════════════════════════════ */

  _getViewData(viewName) {
    const base = {
      shipName: game.settings.get('wy-terminal', 'shipName'),
      shipClass: game.settings.get('wy-terminal', 'shipClass'),
      shipRegistry: game.settings.get('wy-terminal', 'shipRegistry'),
      missionName: game.settings.get('wy-terminal', 'missionName'),
      currentDate: this._getGameDate(),
    };

    switch (viewName) {
      case 'boot':
        return { ...base, systemStatus: 'NOMINAL' };

      case 'status': {
        const eStatus = this.shipStatus?.getStatus() ?? {};
        const sdActive = !!eStatus.selfDestructActive;
        const sdRemaining = sdActive ? this._getSelfDestructRemainingMs() : 0;
        return {
          ...base,
          systems: this._getSystemsData().map(s => ({
            ...s,
            statusClass: this._statusToClass(s.status),
          })),
          selfDestructActive: sdActive,
          selfDestructTimer: sdActive ? this._formatCountdown(sdRemaining) : '',
          selfDestructArmedBy: eStatus.selfDestructArmedBy || '',
          evacuationActive: !!eStatus.evacuationActive,
          evacuationTriggeredBy: eStatus.evacuationTriggeredBy || '',
          lockdownActive: !!eStatus.lockdownActive,
          lockdownTriggeredBy: eStatus.lockdownTriggeredBy || '',
          distressActive: !!eStatus.distressActive,
          distressTriggeredBy: eStatus.distressTriggeredBy || '',
          purgeActive: !!eStatus.purgeActive,
          purgeTriggeredBy: eStatus.purgeTriggeredBy || '',
          purgeTarget: eStatus.purgeTarget || '',
          bioalertActive: !!eStatus.bioalertActive,
          bioalertTriggeredBy: eStatus.bioalertTriggeredBy || '',
          bioalertTarget: eStatus.bioalertTarget || '',
          hasActiveEmergency: sdActive || !!eStatus.evacuationActive || !!eStatus.lockdownActive || !!eStatus.distressActive || !!eStatus.purgeActive || !!eStatus.bioalertActive,
          isGM: game.user.isGM,
        };
      }

      case 'crew':
        return { ...base, crew: this._getCrewData(), activeTasks: this._getActiveTasksData(), isGM: game.user.isGM, availableShips: getAvailableProfiles() };

      case 'systems':
        return { ...base, systems: this._getSystemsDetailData(), isGM: game.user.isGM };

      case 'logs':
        return { ...base, logs: this._getLogData(), isGM: game.user.isGM, activeClearance: this._getActiveClearance() };

      case 'muthur':
        return { ...base, chatHistory: this.chatHistory, muthurHeader: this._getMuthurHeader() };

      case 'scenes':
        return { ...base, ...this._getScenesData() };

      case 'starsystems':
        return { ...base, ...this._getStarSystemsData() };

      case 'emergency':
        return { ...base, ...this._getEmergencyData() };

      case 'nav':
        return { ...base, ...this._getNavData() };

      case 'comms':
        return { ...base, ...this._getCommsData() };

      case 'cargo':
        return { ...base, ...this._getCargoViewData() };

      case 'commandcode': {
        const activeClearance = this._getActiveClearance();
        const playerClearance = this._getPlayerClearance();
        const isGM = game.user.isGM;
        let userList = [];
        if (isGM) {
          const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
          const codes = game.settings.get('wy-terminal', 'userCommandCodes') || {};
          userList = game.users
            .filter(u => !u.isGM)
            .map(u => ({
              id: u.id,
              name: u.name.toUpperCase(),
              clearance: levels[u.id] || 'CREWMEMBER',
              code: codes[u.id]?.code || '',
              role: codes[u.id]?.role || 'CREWMEMBER',
            }));
        }
        return { ...base, activeClearance, playerClearance, userList, isGM };
      }

      case 'gameclock':
        return { ...base, ...this._getGameClockDisplayData() };

      case 'timers':
        return { ...base, ...this._getTimersViewData() };

      case 'weapons':
        return { ...base, ...this._getWeaponsData() };

      case 'science':
        return { ...base, ...this._getScienceData() };

      case 'settings': {
        // Build ship access list for GM controls
        const enabledShips = game.settings.get('wy-terminal', 'enabledShips') || [];
        const shipAccessList = Object.values(SHIP_PROFILES).map(p => ({
          id: p.id,
          name: p.name,
          shipClass: p.shipClass,
          enabled: enabledShips.length === 0 || enabledShips.includes(p.id),
        }));

        // Build Actor folder list for crew filtering
        const crewFolders = game.settings.get('wy-terminal', 'crewFolders') || [];
        const actorFolderList = (game.folders?.filter(f => f.type === 'Actor') || []).map(f => ({
          id: f.id,
          name: f.name,
          count: game.actors?.filter(a => a.folder?.id === f.id && (a.type === 'character' || a.type === 'synthetic')).length || 0,
          enabled: crewFolders.length === 0 || crewFolders.includes(f.id),
        })).filter(f => f.count > 0);

        return {
          ...base,
          muthurUrl: game.settings.get('wy-terminal', 'muthurUrl'),
          statusPath: game.settings.get('wy-terminal', 'statusPath'),
          scanlines: this._normalizeCrtSetting(game.settings.get('wy-terminal', 'scanlines')),
          crtFlicker: this._normalizeCrtSetting(game.settings.get('wy-terminal', 'crtFlicker')),
          soundEnabled: game.settings.get('wy-terminal', 'soundEnabled'),
          openaiBaseUrl: game.settings.get('wy-terminal', 'openaiBaseUrl'),
          openaiApiKey: game.settings.get('wy-terminal', 'openaiApiKey') ? '••••••••' : '',
          openaiModel: game.settings.get('wy-terminal', 'openaiModel'),
          muthurPlugin: game.settings.get('wy-terminal', 'muthurPlugin'),
          availablePlugins: MuthurEngine.getAvailablePlugins(),
          activeShip: game.settings.get('wy-terminal', 'activeShip'),
          availableShips: getAvailableProfiles(),
          shipAccessList,
          actorFolderList,
          navData: this._getNavSettingsData(),
          activeClearance: this._getActiveClearance(),
          isGM: game.user.isGM,
        };
      }

      default:
        return base;
    }
  }

  /* ── System helpers ── */
  _statusToClass(status) {
    switch (status) {
      case 'ONLINE': case 'NOMINAL': return 'online';
      case 'WARNING': return 'warning';
      case 'CRITICAL': return 'critical';
      case 'OFFLINE': default: return 'offline';
    }
  }

  /* ── System data ── */
  _getSystemsData() {
    const systems = this._loadSetting('shipSystems');
    if (systems.length) return systems;

    // Use defaults from active ship profile
    const profile = this._getShipProfile();
    return [...profile.defaultSystems];
  }

  _getSystemsDetailData() {
    const systems = this._getSystemsData();
    return systems.map((s, idx) => {
      const statusClass = this._statusToClass(s.status);
      const pct = s.powerPct ?? (statusClass === 'online' ? 100 : statusClass === 'warning' ? 60 : 0);
      return {
        ...s,
        idx,
        statusClass,
        power: pct > 0 ? 'ACTIVE' : 'OFFLINE',
        notes: s.detail,
        powerPct: pct,
        statusTextClass: statusClass === 'online' ? 'wy-text-green' :
          statusClass === 'warning' ? 'wy-text-amber' :
            statusClass === 'critical' ? 'wy-text-red' : 'wy-text-dim',
        powerColor: statusClass === 'online' ? 'var(--wy-green)' :
          statusClass === 'warning' ? 'var(--wy-amber)' : 'var(--wy-red)',
      };
    });
  }

  /* ── Crew data ── */
  _getCrewData() {
    // Pull live actor data from FoundryVTT actors collection
    let actors = game.actors?.filter(a =>
      (a.type === 'character' || a.type === 'synthetic') && !a.system?.header?.npc
    ) || [];

    // Filter by GM-selected crew folders (if configured)
    const crewFolders = game.settings.get('wy-terminal', 'crewFolders') || [];
    if (crewFolders.length > 0) {
      actors = actors.filter(a => a.folder && crewFolders.includes(a.folder.id));
    }

    // Load GM overrides (status, location) keyed by actor name
    const overrides = this._loadSetting('crewRoster');
    const overrideMap = {};
    for (const o of overrides) {
      if (o.name) overrideMap[o.name.toUpperCase()] = o;
    }

    // Career ID → label mapping for AlienRPG
    const CAREERS = {
      '0': 'COLONIAL MARSHAL', '1': 'COMPANY AGENT', '2': 'KID',
      '3': 'MEDIC', '4': 'OFFICER', '5': 'PILOT',
      '6': 'ROUGHNECK', '7': 'SCIENTIST', '8': 'MARINE',
      '9': 'FREELANCER', '10': 'OPERATIVE', '11': 'SYNTHETIC',
    };

    const crew = actors.map(actor => {
      const sys = actor.system || {};
      const header = sys.header || {};
      const attrs = sys.attributes || {};
      const skills = sys.skills || {};
      const gen = sys.general || {};

      // GM override for this actor (status & location)
      const over = overrideMap[(actor.name || '').toUpperCase()] || {};

      // Determine status and class
      const status = over.status || 'ACTIVE';
      const statusClass = this._crewStatusToClass(status);
      const statusTextClass = statusClass === 'online' ? 'wy-text-green' :
        statusClass === 'warning' ? 'wy-text-amber' : 'wy-text-red';

      // Career/role
      const careerKey = gen.career?.value ?? '';
      const role = over.role || CAREERS[careerKey] || careerKey || 'UNASSIGNED';

      // Health & stress
      const health = header.health || {};
      const stress = header.stress || {};

      // Conditions
      const conditions = [];
      if (gen.starving) conditions.push('STARVING');
      if (gen.dehydrated) conditions.push('DEHYDRATED');
      if (gen.exhausted) conditions.push('EXHAUSTED');
      if (gen.freezing) conditions.push('FREEZING');
      if (gen.hypoxia) conditions.push('HYPOXIA');
      if (gen.gravitydyspraxia) conditions.push('G-DYSPRAXIA');
      if (gen.critInj?.value > 0) conditions.push(`CRIT INJ x${gen.critInj.value}`);

      // Panic conditions (including overwatch/fatigued)
      const panicFlags = ['overwatch','fatigued','jumpy','tunnelvision','aggravated','shakes','frantic',
        'deflated','paranoid','hesitant','freeze','seekcover','scream','flee','frenzy','catatonic'];
      for (const pf of panicFlags) {
        if (gen[pf]) conditions.push(pf.toUpperCase());
      }

      // Ship assignment: flag on actor → GM override → folder-name fallback
      const flagShip = actor.getFlag?.('wy-terminal', 'shipAssignment') || '';
      const shipAssignment = (flagShip || over.shipAssignment || this._inferShipFromFolder(actor) || '').toLowerCase();

      return {
        actorId: actor.id,
        name: (actor.name || 'UNKNOWN').toUpperCase(),
        role: role.toUpperCase(),
        location: (over.location || 'UNKNOWN').toUpperCase(),
        status,
        statusClass,
        statusTextClass,
        shipAssignment,
        img: actor.img || null,
        // Actor sheet data
        health: { value: health.value ?? 0, max: health.max ?? 0 },
        stress: { value: stress.value ?? 0, max: stress.max ?? 10 },
        radiation: { value: gen.radiation?.value ?? 0, max: gen.radiation?.max ?? 10 },
        attributes: {
          str: attrs.str?.value ?? 0,
          agl: attrs.agl?.value ?? 0,
          wit: attrs.wit?.value ?? 0,
          emp: attrs.emp?.value ?? 0,
        },
        skills: {
          heavyMach:    skills.heavyMach?.value ?? 0,
          closeCbt:     skills.closeCbt?.value ?? 0,
          stamina:      skills.stamina?.value ?? 0,
          rangedCbt:    skills.rangedCbt?.value ?? 0,
          mobility:     skills.mobility?.value ?? 0,
          piloting:     skills.piloting?.value ?? 0,
          command:      skills.command?.value ?? 0,
          manipulation: skills.manipulation?.value ?? 0,
          medicalAid:   skills.medicalAid?.value ?? 0,
          observation:  skills.observation?.value ?? 0,
          survival:     skills.survival?.value ?? 0,
          comtech:      skills.comtech?.value ?? 0,
        },
        conditions,
        armor: gen.armor?.value ?? 0,
        appearance: gen.appearance?.value || '',
        agenda: gen.agenda?.value || '',
        buddy: gen.relOne?.value || '',
        rival: gen.relTwo?.value || '',
        sigItem: gen.sigItem?.value || '',
        bio: over.bio || '',
        notes: sys.notes || over.notes || '',
        specialization: over.specialization || '',
        isSynthetic: actor.type === 'synthetic',
      };
    });

    // If no actors matched, fall back to the ship profile defaults
    if (crew.length === 0) {
      const profile = this._getShipProfile();
      return [...profile.defaultCrew];
    }

    // Filter crew by active ship assignment
    const activeShipId = (game.settings.get('wy-terminal', 'activeShip') || 'montero').toLowerCase();
    const filtered = crew.filter(c =>
      !c.shipAssignment || c.shipAssignment === activeShipId
    );

    return filtered;
  }

  /**
   * Infer ship assignment from the actor's folder name.
   * Checks the actor's folder (and parent folder) names against ship profile IDs and names.
   * e.g. a folder named "Montero Crew" or "USCSS MONTERO" → 'montero'
   * @param {Actor} actor
   * @returns {string} ship profile id or ''
   */
  _inferShipFromFolder(actor) {
    if (!actor.folder) return '';
    const folderName = (actor.folder.name || '').toUpperCase();
    // Check against each ship profile
    for (const [id, profile] of Object.entries(SHIP_PROFILES)) {
      const shipName = (profile.name || '').toUpperCase();
      const shipId = id.toUpperCase();
      if (folderName.includes(shipId) || folderName.includes(shipName)) {
        return id;
      }
    }
    // Check parent folder too
    if (actor.folder.folder) {
      const parentName = (actor.folder.folder.name || '').toUpperCase();
      for (const [id, profile] of Object.entries(SHIP_PROFILES)) {
        const shipName = (profile.name || '').toUpperCase();
        const shipId = id.toUpperCase();
        if (parentName.includes(shipId) || parentName.includes(shipName)) {
          return id;
        }
      }
    }
    return '';
  }

  _getActiveTasksData() {
    // Could be populated from ship status
    const status = this.shipStatus?.getStatus() ?? {};
    return status.activeTasks || [];
  }

  /* ── Log data ── */
  _getLogData() {
    // Merge logs from the JSON file (loaded at init) and runtime setting
    const fileLogs = this._fileLogCache || [];
    const settingLogs = this._loadSetting('logEntries');

    // Merge: setting logs first, then file logs
    // Deduplicate by id if present
    const seen = new Set();
    const merged = [];
    for (const log of [...settingLogs, ...fileLogs]) {
      const key = log.id || `${log.timestamp}-${log.subject || log.title || log.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({
          id: log.id || key,
          timestamp: log.timestamp || '',
          sender: (log.sender || log.source || 'SYSTEM').toUpperCase(),
          subject: (log.subject || log.title || log.message || 'UNTITLED').toUpperCase(),
          level: log.level || '',
          detail: log.detail || log.message || '',
          mediaType: log.mediaType || 'text',
          mediaUrl: log.mediaUrl || '',
          classification: (log.classification || '').toUpperCase(),
        });
      }
    }

    // Sort by timestamp ascending (oldest first)
    merged.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Filter classified logs based on the current user's clearance level
    if (!game.user.isGM) {
      const clearance = this._getActiveClearance();
      return merged.filter(l => this._canAccessClassification(l.classification, clearance));
    }
    return merged;
  }

  /**
   * Load log entries from ship-specific muthur/logs-{shipId}.json file.
   * Called during initialization and when switching ships.
   */
  async _loadFileLogEntries() {
    const profileId = (game.settings.get('wy-terminal', 'activeShip') || 'montero');
    const logFile = `modules/wy-terminal/muthur/logs-${profileId}.json`;
    try {
      const resp = await fetch(logFile, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._fileLogCache = Array.isArray(data.logs) ? data.logs : [];
      console.log(`WY-Terminal | Loaded ${this._fileLogCache.length} log entries from logs-${profileId}.json`);
    } catch (err) {
      console.warn(`WY-Terminal | Could not load ${logFile}:`, err.message);
      this._fileLogCache = [];
    }
  }

  /* ── Scenes data ── */
  _getScenesData() {
    const allScenes = game.scenes?.contents ?? [];

    const scenes = allScenes.map(s => ({
      id: s.id,
      name: s.name.toUpperCase(),
      active: s.id === this.activeSceneId,
    }));

    let activeSceneImg = null;
    let activeSceneName = null;
    let tokens = [];

    if (this.activeSceneId) {
      const scene = game.scenes.get(this.activeSceneId);
      if (scene) {
        activeSceneImg = scene.background?.src || scene.img;
        activeSceneName = scene.name;

        // Extract token data for the selected scene
        tokens = this._getSceneTokens(scene);
      }
    }

    // ── Ship selection data (for player ship/deck chooser) ──
    const isGM = game.user.isGM;
    const showShipSelect = !isGM && !this.activeSceneId;

    let ships = [];
    if (showShipSelect) {
      ships = this._getShipSelectData(allScenes);
    }

    return { scenes, activeSceneImg, activeSceneName, tokens, isGM, showShipSelect, ships };
  }

  /**
   * Build the ship selection cards data by matching Foundry scenes to ship profiles.
   * Each ship gets its image, name, registry, and a list of available decks.
   * Respects the GM-configured enabledShips setting — only ships the GM has
   * enabled will appear for players.
   */
  _getShipSelectData(allScenes) {
    const ships = [];
    const enabledShips = game.settings.get('wy-terminal', 'enabledShips') || [];

    for (const [profileId, profile] of Object.entries(SHIP_PROFILES)) {
      // Filter by GM-enabled ships (empty list = all visible)
      if (enabledShips.length > 0 && !enabledShips.includes(profileId)) continue;
      // Match scenes whose name contains the ship identifier (case-insensitive)
      const shipKey = profileId.toLowerCase();                 // e.g. "montero", "cronus"
      const matched = allScenes.filter(s =>
        s.name.toLowerCase().includes(shipKey)
      );

      if (matched.length === 0) continue;

      // Build deck list — extract the deck portion from the scene name
      const decks = matched.map(s => {
        const rawName = s.name.toUpperCase();
        // Strip the ship name prefix to get the deck label
        const prefix = profile.name.split(' ').pop().toUpperCase(); // e.g. "MONTERO", "CRONUS"
        let deckName = rawName.replace(prefix, '').trim();
        if (!deckName) deckName = rawName;  // Single-deck ships keep full name
        return {
          sceneId: s.id,
          deckName: deckName,
        };
      }).sort((a, b) => a.deckName.localeCompare(b.deckName));

      ships.push({
        id: profile.id,
        name: profile.name,
        shipClass: profile.shipClass,
        registry: profile.registry,
        image: `modules/wy-terminal/images/${profileId.toUpperCase()}.png`,
        decks,
      });
    }

    return ships;
  }

  /**
   * Extract token positions/data from a Foundry scene for terminal overlay.
   * Token positions are converted to percentages relative to the background image area.
   * Uses scene.dimensions (grid-snap-aware) for accurate padding offset, with
   * manual fallback for clients where dimensions may be unavailable.
   */
  _getSceneTokens(scene) {
    if (!scene?.tokens?.contents) return [];

    // Use scene.dimensions for accurate scene-origin offset (accounts for
    // grid-snap rounding of the padding). Falls back to manual calculation.
    let padX = 0, padY = 0, imgW, imgH;
    try {
      const dims = scene.dimensions;
      if (dims?.sceneWidth > 0 && dims?.sceneHeight > 0) {
        padX = dims.sceneX || 0;
        padY = dims.sceneY || 0;
        imgW = dims.sceneWidth;
        imgH = dims.sceneHeight;
      }
    } catch { /* dimensions unavailable on this client */ }

    if (!imgW || !imgH) {
      imgW = scene.width || 1;
      imgH = scene.height || 1;
      const padding = scene.padding ?? 0;
      padX = imgW * padding;
      padY = imgH * padding;
    }

    return scene.tokens.contents.map(t => {
      // Convert from canvas pixel coordinates to image-relative percentages
      const xPct = (((t.x || 0) - padX) / imgW) * 100;
      const yPct = (((t.y || 0) - padY) / imgH) * 100;

      // Determine disposition class
      let disposition = 'neutral';
      const disp = t.disposition ?? t.document?.disposition;
      if (disp === 1) disposition = 'friendly';      // FRIENDLY
      else if (disp === 0) disposition = 'neutral';   // NEUTRAL
      else if (disp === -1) disposition = 'hostile';   // HOSTILE
      else if (disp === -2) disposition = 'secret';    // SECRET

      // Token image
      const img = t.texture?.src || t.img || null;

      // Token size (grid-relative)
      const gridSize = scene.grid?.size || scene.data?.grid || 100;
      const tokenWidth = (t.width || 1) * gridSize;
      const displaySize = Math.max(24, Math.min(64, tokenWidth * 0.5));

      return {
        id: t.id,
        name: (t.name || 'UNKNOWN').toUpperCase(),
        actor: (t.actor?.name || t.actorId || '').toUpperCase(),
        x: xPct.toFixed(2),
        y: yPct.toFixed(2),
        size: displaySize,
        img,
        icon: disposition === 'hostile' ? '▲' : disposition === 'friendly' ? '◆' : '●',
        disposition,
        hidden: t.hidden || false,
      };
    }).filter(t => !t.hidden); // Don't show hidden tokens to players
  }

  /**
   * Schedule a debounced token position update.
   * Coalesces multiple rapid calls (from hook + socket retries) into a single DOM update.
   * If precomputed token data is provided (from the GM socket payload), it is used directly
   * instead of reading from local scene documents (which may have stale data on remote clients).
   * @param {Array|null} payloadTokens - Pre-computed token array from socket, or null to read locally.
   */
  scheduleTokenUpdate(payloadTokens = null) {
    // If we receive authoritative data from the GM, prefer it over local reads
    if (payloadTokens) this._pendingTokenPayload = payloadTokens;
    clearTimeout(this._tokenUpdateDebounce);
    this._tokenUpdateDebounce = setTimeout(() => {
      const tokens = this._pendingTokenPayload;
      this._pendingTokenPayload = null;
      if (tokens) {
        this._applyTokenPositions(tokens);
      } else {
        this._updateTokensFromScene();
      }
    }, 80);
  }

  /**
   * Apply pre-computed token positions to the DOM.
   * Used when the GM sends authoritative positions via socket so the player
   * doesn't need to read from potentially-stale local scene documents.
   * @param {Array} freshTokens - Token data array with id, x, y, etc.
   */
  _applyTokenPositions(freshTokens) {
    if (this.activeView !== 'scenes' || !this.activeSceneId) return;

    const el = this.element?.[0] ?? this.element;
    const tokenLayer = el?.querySelector('#wy-token-layer');
    const img = el?.querySelector('#wy-scene-img');
    if (!tokenLayer) return;

    const existingEls = tokenLayer.querySelectorAll('.wy-token');
    const existingIds = new Set();
    existingEls.forEach(te => existingIds.add(te.dataset.tokenId));
    const freshIds = new Set(freshTokens.map(t => t.id));

    // Token set changed (add/remove) — need full re-render
    if (existingIds.size !== freshIds.size ||
        [...existingIds].some(id => !freshIds.has(id)) ||
        [...freshIds].some(id => !existingIds.has(id))) {
      console.log('WY-Terminal | Token set changed — scheduling full re-render');
      if (this._sceneZoom) {
        this._savedZoomState = {
          scale: this._sceneZoom.scale,
          panX: this._sceneZoom.panX,
          panY: this._sceneZoom.panY,
        };
      }
      // Delay re-render briefly to let local doc sync catch up
      setTimeout(() => {
        if (this.rendered && this.activeView === 'scenes') {
          this._renderView('scenes');
        }
      }, 300);
      return;
    }

    // Update positions in-place
    freshTokens.forEach(t => {
      const tokenEl = tokenLayer.querySelector(`[data-token-id="${t.id}"]`);
      if (tokenEl) {
        tokenEl.style.left = `${t.x}%`;
        tokenEl.style.top = `${t.y}%`;
      }
    });

    if (img) this._fitTokenLayer(img, tokenLayer);
  }

  /**
   * Read token positions from local scene documents and update the DOM.
   * Used as fallback when no socket payload is available (e.g. GM's own terminal).
   * Preserves zoom/pan state. Falls back to full re-render if token set changed.
   */
  _updateTokensFromScene() {
    if (this.activeView !== 'scenes' || !this.activeSceneId) return;

    const scene = game.scenes?.get(this.activeSceneId);
    if (!scene) return;

    const freshTokens = this._getSceneTokens(scene);
    this._applyTokenPositions(freshTokens);
  }

  /**
   * Legacy wrapper — immediate update from local scene data.
   * Prefer scheduleTokenUpdate() for debounced updates.
   */
  updateTokensInPlace() {
    this._updateTokensFromScene();
  }

  /* ── Star Systems data ── */
  _getStarSystemsData() {
    const data = this._starSystemsCache ?? { systems: [] };
    const clearance = this._getActiveClearance();
    const systems = (data.systems || []).map(s => {
      const classified = !this._canAccessClassification(s.classification, clearance);
      const statusClass = this._starSystemStatusToClass(s.status);
      const statusTextClass = statusClass === 'online' ? 'wy-text-green' :
        statusClass === 'warning' ? 'wy-text-amber' :
        statusClass === 'critical' ? 'wy-text-red' : 'wy-text-dim';
      return { ...s, classified, statusClass, statusTextClass };
    });
    return { systems, isGM: game.user.isGM };
  }

  _starSystemStatusToClass(status) {
    if (!status) return 'offline';
    const s = status.toUpperCase();
    if (['ACTIVE', 'REBUILDING', 'RECONTACTED'].includes(s)) return 'online';
    if (['SURVEYED', 'SURVEY', 'UNKNOWN', 'UNEXPLORED'].includes(s)) return 'warning';
    if (['QUARANTINE', 'ABANDONED', 'DECOMMISSIONED', 'CLASSIFIED'].includes(s)) return 'critical';
    return 'offline';
  }

  async _loadStarSystemsData() {
    try {
      const resp = await fetch(`modules/wy-terminal/muthur/starsystems.json`);
      const base = await resp.json();
      // Merge GM overrides from world settings
      const overrides = game.settings.get('wy-terminal', 'starSystemsData') ?? { added: [], modified: {}, deleted: [] };
      let systems = (base.systems || []).slice();
      // Apply deletions
      if (overrides.deleted?.length) {
        systems = systems.filter(s => !overrides.deleted.includes(s.id));
      }
      // Apply modifications
      if (overrides.modified && Object.keys(overrides.modified).length) {
        systems = systems.map(s => overrides.modified[s.id] ? { ...s, ...overrides.modified[s.id] } : s);
      }
      // Append added systems
      if (overrides.added?.length) {
        systems = systems.concat(overrides.added);
      }
      this._starSystemsCache = { ...base, systems };
    } catch (err) {
      console.error('WY-Terminal | Failed to load star systems database:', err);
      this._starSystemsCache = { systems: [] };
    }
  }

  /* ── Emergency data ── */
  _getEmergencyData() {
    const status = this.shipStatus?.getStatus() ?? {};
    const sdActive = !!status.selfDestructActive;
    const remaining = sdActive ? this._getSelfDestructRemainingMs() : 0;
    return {
      selfDestructActive: sdActive,
      selfDestructTimer: sdActive ? this._formatCountdown(remaining) : '00:00:00',
      selfDestructArmedBy: status.selfDestructArmedBy || '',
      evacuationActive: !!status.evacuationActive,
      evacuationTriggeredBy: status.evacuationTriggeredBy || '',
      lockdownActive: !!status.lockdownActive,
      lockdownTriggeredBy: status.lockdownTriggeredBy || '',
      distressActive: !!status.distressActive,
      distressTriggeredBy: status.distressTriggeredBy || '',
      purgeActive: !!status.purgeActive,
      purgeTriggeredBy: status.purgeTriggeredBy || '',
      purgeTarget: status.purgeTarget || '',
      bioalertActive: !!status.bioalertActive,
      bioalertTriggeredBy: status.bioalertTriggeredBy || '',
      bioalertTarget: status.bioalertTarget || '',
      isGM: game.user.isGM,
    };
  }

  /* ── Nav settings data (for GM controls form) ── */
  _getNavSettingsData() {
    const nav = this._loadSetting('navData') || {};
    // Pull engine/thruster status from systems
    const systems = this._getSystemsData();
    const engSys = systems.find(s => s.name === 'ENGINES');
    const thrSys = systems.find(s => /THRUSTER/i.test(s.name));
    return {
      heading: nav.heading || '',
      speed: nav.speed || '',
      fuel: nav.fuel || '',
      eta: nav.eta || '',
      position: nav.position || '',
      destination: nav.destination || '',
      engineStatus: engSys?.status || 'ONLINE',
      thrusterStatus: thrSys?.status || 'NOMINAL',
    };
  }

  /* ── Route path helpers (shared by _getNavData & _initNavView) ── */

  /** Build ordered route: DEPARTURE → WAYPOINT(s) → DESTINATION. */
  _buildRoutePath(markers) {
    const dep = markers.find(m => m.type === 'DEPARTURE');
    const dest = markers.find(m => m.type === 'DESTINATION');
    if (!dep || !dest) return [];
    const waypoints = markers.filter(m => m.type === 'WAYPOINT');
    return [dep, ...waypoints, dest];
  }

  /** Cumulative segment distances for a route path. */
  _getRouteSegments(path) {
    const segments = [];
    let totalDist = 0;
    for (let i = 1; i < path.length; i++) {
      const dx = path[i].x - path[i - 1].x;
      const dy = path[i].y - path[i - 1].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      segments.push({ from: path[i - 1], to: path[i], dist });
      totalDist += dist;
    }
    return { segments, totalDist };
  }

  /** Interpolate position + heading on route at progress (0-1). */
  _positionOnRoute(path, progress) {
    if (path.length < 2) return { x: 0, y: 0, angle: 0 };
    const { segments, totalDist } = this._getRouteSegments(path);
    if (totalDist === 0) return { x: path[0].x, y: path[0].y, angle: 0 };

    const targetDist = progress * totalDist;
    let accumulated = 0;
    for (const seg of segments) {
      if (accumulated + seg.dist >= targetDist || seg === segments[segments.length - 1]) {
        const segProgress = seg.dist > 0 ? (targetDist - accumulated) / seg.dist : 0;
        const t = Math.max(0, Math.min(1, segProgress));
        return {
          x: seg.from.x + (seg.to.x - seg.from.x) * t,
          y: seg.from.y + (seg.to.y - seg.from.y) * t,
          angle: Math.atan2(seg.to.y - seg.from.y, seg.to.x - seg.from.x),
        };
      }
      accumulated += seg.dist;
    }
    const last = path[path.length - 1];
    return { x: last.x, y: last.y, angle: 0 };
  }

  /** Project a point onto the route and return closest { progress, x, y }. */
  _projectOntoRoute(path, px, py) {
    if (path.length < 2) return { progress: 0, x: px, y: py };
    const { segments, totalDist } = this._getRouteSegments(path);
    if (totalDist === 0) return { progress: 0, x: path[0].x, y: path[0].y };

    let bestDist = Infinity, bestX = px, bestY = py, bestAccum = 0;
    let accumulated = 0;
    for (const seg of segments) {
      const dx = seg.to.x - seg.from.x, dy = seg.to.y - seg.from.y;
      const len2 = dx * dx + dy * dy;
      let t = 0;
      if (len2 > 0) t = Math.max(0, Math.min(1, ((px - seg.from.x) * dx + (py - seg.from.y) * dy) / len2));
      const cx = seg.from.x + dx * t, cy = seg.from.y + dy * t;
      const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
      if (d < bestDist) {
        bestDist = d;
        bestX = cx;
        bestY = cy;
        bestAccum = accumulated + t * seg.dist;
      }
      accumulated += seg.dist;
    }
    return { progress: totalDist > 0 ? bestAccum / totalDist : 0, x: bestX, y: bestY };
  }

  /* ── Nav data ── */
  _getNavData() {
    const nav = this._loadSetting('navData') || {};
    const systems = this._getSystemsData();
    const engSys = systems.find(s => s.name === 'ENGINES');
    const thrSys = systems.find(s => /THRUSTER/i.test(s.name));
    const engineStatus = engSys?.status || 'ONLINE';
    const thrusterStatus = thrSys?.status || 'NOMINAL';

    const fuel = nav.fuel || '87%';
    const fuelNum = parseInt(fuel) || 87;
    let fuelClass = 'wy-text-green';
    if (fuelNum <= 25) fuelClass = 'wy-text-red';
    else if (fuelNum <= 50) fuelClass = 'wy-text-amber';

    // Check the default NAV ETA timer for live countdown
    let etaDisplay = nav.eta || 'N/A';
    let etaCountdownMs = 0;
    const etaTimer = this._getActiveTimers().find(t => t.id === DEFAULT_NAV_ETA_ID);
    if (etaTimer && etaTimer.remainingMs > 0) {
      etaCountdownMs = etaTimer.remainingMs;
      etaDisplay = this._formatDuration(etaCountdownMs);
    }

    // NAV markers with formatted coord labels for the table
    const rawMarkers = nav.navMarkers || [];
    const navMarkers = rawMarkers.map(m => ({
      ...m,
      coordLabel: m.type === 'PLAYER' && m.progress !== undefined
        ? `TRANSIT: ${Math.round(m.progress * 100)}%`
        : `${(m.x * 100).toFixed(1)}%, ${(m.y * 100).toFixed(1)}%`,
    }));

    // Derive position and destination from markers when available
    const destMarker = rawMarkers.find(m => m.type === 'DESTINATION');
    const playerMarker = rawMarkers.find(m => m.type === 'PLAYER');
    const routePath = this._buildRoutePath(rawMarkers);

    // POSITION: use PLAYER marker coordinates on route path
    let currentPosition = nav.position || 'SECTOR 87-C / ZETA RETICULI';
    if (playerMarker) {
      let px = playerMarker.x, py = playerMarker.y;
      if (routePath.length >= 2 && playerMarker.progress !== undefined) {
        const pos = this._positionOnRoute(routePath, playerMarker.progress);
        px = pos.x;
        py = pos.y;
      }
      currentPosition = `${playerMarker.label} — ${(px * 100).toFixed(1)}%, ${(py * 100).toFixed(1)}%`;
    }

    // DESTINATION: use DESTINATION marker label + coords
    let destination = nav.destination || 'NOT SET';
    let dstCoordinates = 'N/A';
    if (destMarker) {
      destination = destMarker.label;
      dstCoordinates = `${(destMarker.x * 100).toFixed(1)}%, ${(destMarker.y * 100).toFixed(1)}%`;
    }

    return {
      currentPosition,
      destination,
      dstCoordinates,
      heading: nav.heading || '042.7',
      eta: etaDisplay,
      etaCountdownMs,
      clockPaused: game.settings.get('wy-terminal', 'gameClockPaused') ?? false,
      speed: nav.speed || 'STATION KEEPING',
      fuelLevel: fuel,
      fuelClass,
      engineStatus,
      engineClass: (engineStatus === 'OFFLINE') ? 'wy-text-red' : 'wy-text-green',
      thrusterStatus,
      thrusterClass: (thrusterStatus === 'OFFLINE') ? 'wy-text-red' : 'wy-text-green',
      navPoints: nav.navPoints || [],
      navMarkers,
      isGM: game.user.isGM,
    };
  }

  /* ── Comms data ── */
  _getCommsData() {
    // Derive COMM STATUS from the COMMS ARRAY entry in shipSystems
    const systems = this._getSystemsData();
    const commsArray = systems.find(s => s.name?.toUpperCase().includes('COMMS'));
    const commsStatus = commsArray?.status || 'ONLINE';
    const commsStatusClass = this._statusToClass(commsStatus);

    // Frequency from dedicated setting
    let freq;
    try { freq = game.settings.get('wy-terminal', 'commFrequency'); } catch { freq = ''; }
    if (!freq) freq = '475.12';

    // Range varies by status
    const range = commsStatusClass === 'offline' ? 'N/A' :
                  commsStatusClass === 'critical' ? '10 AU' :
                  commsStatusClass === 'warning' ? '50 AU' : '100 AU';

    const status = this.shipStatus?.getStatus() ?? {};

    return {
      commStatus: commsStatus,
      commStatusClass: commsStatusClass,
      commFrequency: `${freq} MHz`,
      commRange: range,
      messages: status.messages || [],
      isGM: game.user.isGM,
    };
  }

  /* ── Cargo data ── */
  _getCargoData() {
    const stored = this._loadSetting('cargoManifest');
    if (stored?.length) return stored;
    const profile = this._getShipProfile();
    return profile?.defaultCargo ?? [];
  }

  /**
   * Full view-data for cargo template (list + form helpers).
   */
  _getCargoViewData() {
    const cargoItems = this._getCargoData();
    // Build location optgroup data for form dropdown (reusing crew logic)
    const shipLocations = this._getLocationOptionGroups();
    return { cargoItems, shipLocations, isGM: game.user.isGM };
  }

  /**
   * Return location optgroups array for <select> dropdowns.
   * Shared by crew and cargo forms.
   */
  _getLocationOptionGroups() {
    const UNIVERSAL = ['UNKNOWN', 'UMBILICAL', 'EXTERNAL'];
    const MONTERO = ['BRIDGE', 'MEDLAB', 'GALLERY', 'CRYO', 'CARGO BAY', 'ENGINEERING', 'EVA LOCKER', 'SUPPLY CLOSET', 'TOOL LOCKER'];
    const CRONUS = [
      '(DECK D) VEHICLE BAY',
      '(DECK C) REACTOR', '(DECK C) JUNCTION C-2', '(DECK C) CARGO BAY 1', '(DECK C) CARGO BAY 2', '(DECK C) CARGO OFFICE', '(DECK C) JUNCTION C-1', '(DECK C) FORWARD', '(DECK C) AFT',
      '(DECK B) BRIDGE', '(DECK B) JUNCTION B-1', '(DECK B) VESTIBULE 1', '(DECK B) VESTIBULE 2', '(DECK B) MESS HALL', '(DECK B) CORPORATE SUITE', '(DECK B) LIVING AREA', '(DECK B) JUNCTION B-2', '(DECK B) MEDLAB', '(DECK B) SCI LAB 2', '(DECK B) SCI LAB 1', '(DECK B) SCIENCE SECTOR', '(DECK B) FORWARD', '(DECK B) AFT',
      '(DECK A) MU/TH/UR', '(DECK A) JUNCTION A-1', '(DECK A) EXAMINATION ROOM', '(DECK A) JUNCTION A-2', '(DECK A) CRYO SECTOR', '(DECK A) FORWARD', '(DECK A) AFT',
      'ARMORY',
    ];

    const groups = [{ group: 'GENERAL', items: UNIVERSAL }];
    groups.push({ group: 'MONTERO', items: MONTERO });
    groups.push({ group: 'CRONUS — DECK D', items: CRONUS.filter(l => l.startsWith('(DECK D)')) });
    groups.push({ group: 'CRONUS — DECK C', items: CRONUS.filter(l => l.startsWith('(DECK C)')) });
    groups.push({ group: 'CRONUS — DECK B', items: CRONUS.filter(l => l.startsWith('(DECK B)')) });
    groups.push({ group: 'CRONUS — DECK A', items: CRONUS.filter(l => l.startsWith('(DECK A)')) });
    groups.push({ group: 'CRONUS — OTHER', items: CRONUS.filter(l => !l.startsWith('(DECK')) });
    return groups;
  }

  /* ── Weapons data (Cronus tactical systems) ── */
  _getWeaponsData() {
    const profile = this._getShipProfile();
    const systems = this._getSystemsDetailData();
    const weaponNames = ['RAIL GUN', 'MISSILE BATTERY', 'POINT DEFENSE SYS'];

    const weapons = systems
      .filter(s => weaponNames.includes(s.name))
      .map(s => ({
        name: s.name,
        status: s.status,
        statusClass: this._statusToClass(s.status),
        statusTextClass: `wy-text-${this._statusToClass(s.status) === 'online' ? 'green' : this._statusToClass(s.status) === 'warning' ? 'amber' : 'red'}`,
        ammo: s.name === 'MISSILE BATTERY' ? (s.detail || '12 RDS LOADED') : '∞',
        notes: s.detail || '',
        powerPct: s.powerPct ?? 100,
        powerColor: (s.powerPct ?? 100) > 60 ? '#ff3333' : (s.powerPct ?? 100) > 30 ? '#ffbf00' : '#555',
      }));

    // If no weapons found in systems, use defaults from profile
    if (weapons.length === 0) {
      const defaults = profile.defaultSystems.filter(s => weaponNames.includes(s.name));
      weapons.push(...defaults.map(s => ({
        name: s.name,
        status: s.status,
        statusClass: this._statusToClass(s.status),
        statusTextClass: 'wy-text-green',
        ammo: s.name === 'MISSILE BATTERY' ? (s.detail || '12 RDS LOADED') : '∞',
        notes: s.detail || '',
        powerPct: s.powerPct ?? 100,
        powerColor: '#ff3333',
      })));
    }

    return {
      weapons,
      targetingMode: 'AUTO-TRACK',
      targetLock: 'NO LOCK',
      targetLockClass: 'wy-text-dim',
      threatLevel: 'NONE DETECTED',
      threatClass: 'wy-text-green',
    };
  }

  /* ── Science data (Cronus research pod) ── */
  _getScienceData() {
    return {
      labs: [
        { name: 'LAB-A (XENOBIOLOGY)',    status: 'ACTIVE',  statusClass: 'online', statusTextClass: 'wy-text-green', assignment: 'SPECIMEN ANALYSIS', notes: 'LV-1113 SAMPLES' },
        { name: 'LAB-B (PATHOLOGY)',       status: 'ACTIVE',  statusClass: 'online', statusTextClass: 'wy-text-green', assignment: 'BIO-HAZARD SCREENING', notes: 'LEVEL 4 CONTAINMENT' },
        { name: 'CRYO RESEARCH UNIT',      status: 'STANDBY', statusClass: 'warning', statusTextClass: 'wy-text-amber', assignment: 'UNASSIGNED', notes: '—' },
      ],
      specimens: [
        { unit: 'UNIT-01', containment: 'SEALED',  statusClass: 'online',  statusTextClass: 'wy-text-green', hazardLevel: 'LEVEL 4', hazardClass: 'wy-text-red',   contents: 'ORGANIC SAMPLE — LV-1113' },
        { unit: 'UNIT-02', containment: 'SEALED',  statusClass: 'online',  statusTextClass: 'wy-text-green', hazardLevel: 'LEVEL 2', hazardClass: 'wy-text-amber', contents: 'ATMOSPHERIC RESIDUE' },
        { unit: 'UNIT-03', containment: 'VACANT',  statusClass: 'offline', statusTextClass: 'wy-text-dim',   hazardLevel: '—',       hazardClass: 'wy-text-dim',   contents: '—' },
        { unit: 'UNIT-04', containment: 'VACANT',  statusClass: 'offline', statusTextClass: 'wy-text-dim',   hazardLevel: '—',       hazardClass: 'wy-text-dim',   contents: '—' },
      ],
      atmosphere: 'NOMINAL',
      radiation: 'SAFE',
      radiationClass: 'wy-text-green',
      bioContaminant: 'NEGATIVE',
      bioClass: 'wy-text-green',
      quarantine: 'INACTIVE',
      quarantineClass: 'wy-text-dim',
    };
  }

  /* ══════════════════════════════════════════════════════════════════
     POST-RENDER HOOKS — Wire up view-specific interactions
     ══════════════════════════════════════════════════════════════════ */

  _onViewRendered(viewName, contentEl) {
    // Boot sound for player terminal
    if (viewName === 'boot') TerminalSFX.play('boot');

    switch (viewName) {
      case 'status':
        this._setupStatusView(contentEl);
        break;
      case 'logs':
        this._setupLogsView(contentEl);
        break;
      case 'muthur':
        this._setupMuthurView(contentEl);
        break;
      case 'scenes':
        this._setupScenesView(contentEl);
        break;
      case 'starsystems':
        this._setupStarSystemsView(contentEl);
        break;
      case 'systems':
        this._setupSystemsView(contentEl);
        break;
      case 'emergency':
        this._setupEmergencyView(contentEl);
        break;
      case 'settings':
        this._setupSettingsView(contentEl);
        break;
      case 'nav':
        this._setupNavView(contentEl);
        break;
      case 'crew':
        this._setupCrewView(contentEl);
        break;
      case 'commandcode':
        this._setupCommandCodeView(contentEl);
        break;
      case 'cargo':
        this._setupCargoView(contentEl);
        break;
      case 'comms':
        this._setupCommsView(contentEl);
        break;
      case 'gameclock':
        this._setupGameClockView(contentEl);
        break;
      case 'timers':
        this._setupTimersView(contentEl);
        break;
      case 'weapons':
      case 'science':
        // Read-only views — no interactive setup needed
        break;
    }
  }

  /* ── Logs View Setup — List/Detail views + GM form ── */
  _setupLogsView(contentEl) {
    // Cache log data for detail view lookup
    this._currentLogs = this._getLogData();
    this._editingLogId = null; // Track if we're editing an existing log

    const listView = contentEl.querySelector('#wy-log-list-view');
    const detailView = contentEl.querySelector('#wy-log-detail-view');

    // [VIEW] button handler — open detail view for selected log
    contentEl.querySelectorAll('[data-action="view-log"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const logId = btn.dataset.logId;
        const log = this._currentLogs.find(l => l.id === logId);
        if (!log) return;

        // Check classification-based access (GM always passes)
        if (!game.user.isGM && log.classification) {
          const clearance = this._getActiveClearance();
          if (!this._canAccessClassification(log.classification, clearance)) {
            const required = this._requiredClearanceFor(log.classification);
            this._showClearanceOverlay(
              'ACCESS DENIED',
              `${log.classification} CLASSIFIED \u2014 REQUIRES ${required} CLEARANCE OR HIGHER`,
              { currentClearance: clearance }
            );
            return;
          }
        }

        // Populate detail header
        const dateEl = contentEl.querySelector('#wy-log-detail-date');
        const senderEl = contentEl.querySelector('#wy-log-detail-sender');
        const subjectEl = contentEl.querySelector('#wy-log-detail-subject');
        const bodyEl = contentEl.querySelector('#wy-log-detail-body');

        if (dateEl) dateEl.textContent = `[${log.timestamp}]`;
        if (senderEl) senderEl.textContent = log.sender;
        if (subjectEl) subjectEl.textContent = log.subject;

        // Populate body based on media type
        if (bodyEl) {
          bodyEl.innerHTML = '';

          if (log.mediaType === 'image' && log.mediaUrl) {
            const img = document.createElement('img');
            img.className = 'wy-log-media-img';
            img.src = log.mediaUrl;
            img.alt = log.subject;
            bodyEl.appendChild(img);
          } else if (log.mediaType === 'video' && log.mediaUrl) {
            const video = document.createElement('video');
            video.className = 'wy-log-media-video';
            video.src = log.mediaUrl;
            video.controls = true;
            video.autoplay = false;
            bodyEl.appendChild(video);
          } else if (log.mediaType === 'audio' && log.mediaUrl) {
            this._buildAudioWaveformPlayer(bodyEl, log.mediaUrl);
          }

          // Always show detail text if present
          if (log.detail) {
            const pre = document.createElement('pre');
            pre.className = 'wy-log-detail-text';
            pre.textContent = log.detail;
            bodyEl.appendChild(pre);
          }
        }

        // Apply level class to detail container
        const container = contentEl.querySelector('.wy-log-detail-container');
        if (container) {
          container.className = `wy-log-detail-container ${log.level || ''}`;
        }

        // Show detail, hide list
        this._currentDetailLog = log;
        listView?.classList.add('wy-hidden');
        detailView?.classList.remove('wy-hidden');
      });
    });

    // [CLOSE] button handler — return to list
    contentEl.querySelector('[data-action="close-log"]')?.addEventListener('click', () => {
      detailView?.classList.add('wy-hidden');
      listView?.classList.remove('wy-hidden');
    });

    // GM: [EDIT] button in detail view — populate form with current log data
    contentEl.querySelector('[data-action="edit-log"]')?.addEventListener('click', () => {
      if (!game.user.isGM || !this._currentDetailLog) return;
      const log = this._currentDetailLog;
      this._editingLogId = log.id;

      const form = contentEl.querySelector('#wy-log-form');
      const formTitle = contentEl.querySelector('#wy-log-form-title');
      if (!form) return;

      // Update form title
      if (formTitle) formTitle.textContent = 'EDIT LOG ENTRY';

      // Populate form fields with existing data
      const dateInput = contentEl.querySelector('#wy-log-form-date');
      const senderInput = contentEl.querySelector('#wy-log-form-sender');
      const subjectInput = contentEl.querySelector('#wy-log-form-subject');
      const levelSelect = contentEl.querySelector('#wy-log-form-level');
      const classSelect = contentEl.querySelector('#wy-log-form-classification');
      const mediaSelect = contentEl.querySelector('#wy-log-form-media-type');
      const mediaUrlInput = contentEl.querySelector('#wy-log-form-media-url');
      const mediaUrlRow = contentEl.querySelector('#wy-log-form-media-url-row');
      const detailInput = contentEl.querySelector('#wy-log-form-detail');

      if (dateInput) dateInput.value = log.timestamp || '';
      if (senderInput) senderInput.value = log.sender || '';
      if (subjectInput) subjectInput.value = log.subject || '';
      if (levelSelect) levelSelect.value = log.level || '';
      if (classSelect) classSelect.value = log.classification || '';
      if (mediaSelect) mediaSelect.value = log.mediaType || 'text';
      if (mediaUrlInput) mediaUrlInput.value = log.mediaUrl || '';
      if (mediaUrlRow) mediaUrlRow.classList.toggle('wy-hidden', (log.mediaType || 'text') === 'text');
      if (detailInput) detailInput.value = log.detail || '';

      // Switch views: hide detail, show list + form
      detailView?.classList.add('wy-hidden');
      listView?.classList.remove('wy-hidden');
      form.classList.remove('wy-hidden');
      form.scrollIntoView({ behavior: 'smooth' });
    });

    // GM: delete log entry (from detail view)
    contentEl.querySelector('[data-action="delete-log"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const logId = this._currentDetailLog?.id;
      if (!logId || !game.user.isGM) return;

      // Remove from runtime setting logs
      const settingLogs = this._loadSetting('logEntries');
      const filtered = settingLogs.filter(l => l.id !== logId);
      if (filtered.length < settingLogs.length) {
        await game.settings.set('wy-terminal', 'logEntries', filtered);
      }

      // Also remove from file log cache (so it stays gone until reset)
      if (this._fileLogCache) {
        this._fileLogCache = this._fileLogCache.filter(l => l.id !== logId);
      }

      ui.notifications.info('WY-Terminal: Log entry deleted.');
      this._broadcastSocket('refreshView', { view: 'logs' });
      this._renderView('logs');
    });

    // GM: show/hide new log form
    const addBtn = contentEl.querySelector('[data-action="add-log"]');
    const form = contentEl.querySelector('#wy-log-form');
    if (addBtn && form) {
      addBtn.addEventListener('click', () => {
        // Reset to create mode
        this._editingLogId = null;
        const formTitle = contentEl.querySelector('#wy-log-form-title');
        if (formTitle) formTitle.textContent = 'CREATE NEW LOG ENTRY';
        // Clear form fields
        const dateInput = contentEl.querySelector('#wy-log-form-date');
        if (dateInput) dateInput.value = this._getGameDate();
        contentEl.querySelector('#wy-log-form-sender').value = '';
        contentEl.querySelector('#wy-log-form-subject').value = '';
        contentEl.querySelector('#wy-log-form-level').value = '';
        contentEl.querySelector('#wy-log-form-classification').value = '';
        contentEl.querySelector('#wy-log-form-media-type').value = 'text';
        contentEl.querySelector('#wy-log-form-media-url').value = '';
        contentEl.querySelector('#wy-log-form-media-url-row')?.classList.add('wy-hidden');
        contentEl.querySelector('#wy-log-form-detail').value = '';
        form.classList.toggle('wy-hidden');
      });
    }

    // GM: media type toggle — show/hide URL field
    const mediaTypeSelect = contentEl.querySelector('#wy-log-form-media-type');
    const mediaUrlRow = contentEl.querySelector('#wy-log-form-media-url-row');
    if (mediaTypeSelect && mediaUrlRow) {
      mediaTypeSelect.addEventListener('change', () => {
        const isMedia = mediaTypeSelect.value !== 'text';
        mediaUrlRow.classList.toggle('wy-hidden', !isMedia);
      });
    }

    // GM: cancel log form
    contentEl.querySelector('[data-action="cancel-log"]')?.addEventListener('click', () => {
      this._editingLogId = null;
      const formTitle = contentEl.querySelector('#wy-log-form-title');
      if (formTitle) formTitle.textContent = 'CREATE NEW LOG ENTRY';
      form?.classList.add('wy-hidden');
    });

    // GM: submit log form (create or update)
    contentEl.querySelector('[data-action="submit-log"]')?.addEventListener('click', async () => {
      const dateVal = contentEl.querySelector('#wy-log-form-date')?.value || '';
      const sender = contentEl.querySelector('#wy-log-form-sender')?.value || 'SYSTEM';
      const subject = contentEl.querySelector('#wy-log-form-subject')?.value || 'UNTITLED';
      const level = contentEl.querySelector('#wy-log-form-level')?.value || '';
      const detail = contentEl.querySelector('#wy-log-form-detail')?.value || '';
      const mediaType = contentEl.querySelector('#wy-log-form-media-type')?.value || 'text';
      const mediaUrl = contentEl.querySelector('#wy-log-form-media-url')?.value || '';
      const classification = contentEl.querySelector('#wy-log-form-classification')?.value || '';

      if (!subject.trim()) {
        ui.notifications.warn('WY-Terminal: Log subject is required.');
        return;
      }

      if (this._editingLogId) {
        // ── UPDATE existing log ──
        const logs = this._loadSetting('logEntries');
        const idx = logs.findIndex(l => l.id === this._editingLogId);
        if (idx !== -1) {
          logs[idx] = {
            ...logs[idx],
            timestamp: dateVal || logs[idx].timestamp,
            sender: sender.toUpperCase(),
            subject: subject.toUpperCase(),
            level,
            detail: (detail || subject).toUpperCase(),
            mediaType: mediaType || 'text',
            mediaUrl: mediaUrl || '',
            classification: (classification || '').toUpperCase(),
          };
          await game.settings.set('wy-terminal', 'logEntries', logs);

          // Also update file cache if present
          if (this._fileLogCache) {
            const cacheIdx = this._fileLogCache.findIndex(l => l.id === this._editingLogId);
            if (cacheIdx !== -1) {
              this._fileLogCache[cacheIdx] = { ...logs[idx] };
            }
          }

          ui.notifications.info('WY-Terminal: Log entry updated.');
        } else {
          ui.notifications.warn('WY-Terminal: Could not find log to update.');
        }
        this._editingLogId = null;
      } else {
        // ── CREATE new log ──
        await this._addLog(sender, subject, level, detail || subject, mediaType, mediaUrl, dateVal, classification);
        ui.notifications.info('WY-Terminal: Log entry created.');
        // Alert player terminals — flash the LOGS button
        console.log('WY-Terminal | Broadcasting newLogAlert to player terminals');
        this._broadcastSocket('newLogAlert', {});
      }

      // Refresh logs view and broadcast to players
      this._renderView('logs');
      this._broadcastSocket('refreshView', { view: 'logs' });
    });
  }

  /* ── Systems View Setup — GM configuration ── */
  _setupSystemsView(contentEl) {
    if (!game.user.isGM) return;

    // Status dropdown changes → auto-update statusClass indicator & power bar preview
    contentEl.querySelectorAll('.wy-sys-status').forEach(sel => {
      sel.addEventListener('change', () => {
        const row = sel.closest('tr');
        if (!row) return;
        const indicator = row.querySelector('.wy-indicator');
        const pctInput = row.querySelector('.wy-sys-pct');
        const pctLabel = row.querySelector('.wy-sys-pct-label');
        const barFill = row.closest('.wy-view-systems')
          ?.querySelector(`.wy-power-bar-fill[data-idx="${row.dataset.idx}"]`);

        // Derive class from new status
        const cls = { ONLINE: 'online', NOMINAL: 'online', WARNING: 'warning', CRITICAL: 'critical', OFFLINE: 'offline' }[sel.value] || 'offline';
        if (indicator) { indicator.className = `wy-indicator ${cls}`; }

        // Auto-set percentage based on status (GM can still override)
        const autoPct = { ONLINE: 100, NOMINAL: 100, WARNING: 60, CRITICAL: 30, OFFLINE: 0 }[sel.value] ?? 0;
        if (pctInput) pctInput.value = autoPct;
        if (pctLabel) pctLabel.textContent = `${autoPct}%`;
        if (barFill) {
          barFill.style.width = `${autoPct}%`;
          barFill.style.background = cls === 'online' ? 'var(--wy-green)' : cls === 'warning' ? 'var(--wy-amber)' : 'var(--wy-red)';
        }
      });
    });

    // Range slider live preview
    contentEl.querySelectorAll('.wy-sys-pct').forEach(input => {
      input.addEventListener('input', () => {
        const row = input.closest('tr');
        const pctLabel = row?.querySelector('.wy-sys-pct-label');
        const barFill = input.closest('.wy-view-systems')
          ?.querySelector(`.wy-power-bar-fill[data-idx="${row?.dataset.idx}"]`);
        if (pctLabel) pctLabel.textContent = `${input.value}%`;
        if (barFill) barFill.style.width = `${input.value}%`;
      });
    });

    // Save button
    const saveBtn = contentEl.querySelector('[data-action="save-systems"]');
    if (!saveBtn) return;
    saveBtn.addEventListener('click', async () => {
      const rows = contentEl.querySelectorAll('.wy-sys-row');
      const newSystems = [];
      rows.forEach(row => {
        newSystems.push({
          name: row.querySelector('.wy-sys-name')?.value?.trim() || 'UNKNOWN',
          status: row.querySelector('.wy-sys-status')?.value || 'OFFLINE',
          detail: row.querySelector('.wy-sys-detail')?.value?.trim() || '',
          powerPct: parseInt(row.querySelector('.wy-sys-pct')?.value ?? '0', 10),
        });
      });

      // Detect status changes vs current saved data
      const oldSystems = this._getSystemsData();
      const changes = [];
      for (const ns of newSystems) {
        const os = oldSystems.find(s => s.name === ns.name);
        if (os && os.status !== ns.status) {
          changes.push({ name: ns.name, from: os.status, to: ns.status });
        }
      }

      // If GM made status changes, prompt for reason (timestamp from game clock)
      let reason = '';
      const logTimestamp = this._getGameDate();
      if (changes.length && game.user.isGM) {
        const changeList = changes.map(c => `  ${c.name}: ${c.from} → ${c.to}`).join('\n');
        reason = await new Promise(resolve => {
          new Dialog({
            title: 'System Status Change — Log Entry',
            content: `
              <p style="margin-bottom:8px;">The following system status changes were detected:</p>
              <pre style="background:rgba(0,0,0,.3);padding:8px;border:1px solid #555;white-space:pre-wrap;font-family:monospace;font-size:12px;margin-bottom:12px;">${changeList}</pre>

              <div style="margin-bottom:12px;padding:8px;border:1px solid #555;background:rgba(0,0,0,.2);text-align:center;">
                <span style="font-size:11px;opacity:.7;letter-spacing:1px;">GAME CLOCK</span><br>
                <span style="font-family:monospace;font-size:16px;font-weight:bold;">${logTimestamp}</span>
              </div>

              <label style="display:block;margin-bottom:4px;font-weight:bold;">Reason / Cause:</label>
              <textarea id="wy-sys-reason" style="width:100%;height:60px;resize:vertical;font-family:monospace;" placeholder="e.g. Hull breach in cargo bay"></textarea>
            `,
            buttons: {
              ok: {
                label: 'Save',
                callback: (html) => resolve(html.find('#wy-sys-reason').val()?.trim() || ''),
              },
              skip: {
                label: 'Skip',
                callback: () => resolve(''),
              },
            },
            default: 'ok',
            close: () => resolve(''),
          }).render(true);
        });
      }

      // Persist systems
      await game.settings.set('wy-terminal', 'shipSystems', newSystems);

      // Create log entries for each status change
      for (const c of changes) {
        const lvl = (c.to === 'OFFLINE' || c.to === 'CRITICAL') ? 'error' :
                    c.to === 'WARNING' ? 'warning' : 'info';
        const detail = reason
          ? `${c.name}: ${c.from} → ${c.to}\nREASON: ${reason}`
          : `${c.name}: ${c.from} → ${c.to}`;
        await this._addLog('MU/TH/UR', `SYSTEM STATUS CHANGE: ${c.name}`, lvl, detail, 'text', '', logTimestamp);
      }
      if (changes.length) {
        this._broadcastSocket('newLogAlert', {});
      }

      ui.notifications.info('WY-Terminal: Ship systems updated.');
      this._broadcastSocket('refreshView', { view: 'systems' });
      this._broadcastSocket('refreshView', { view: 'comms' });
      this._broadcastSocket('refreshView', { view: 'logs' });
      this._renderView('systems');
    });

    // Add System button
    const addBtn = contentEl.querySelector('[data-action="add-system"]');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const current = this._getSystemsData();
        current.push({ name: 'NEW SYSTEM', status: 'OFFLINE', detail: '', powerPct: 0 });
        await game.settings.set('wy-terminal', 'shipSystems', current);
        this._broadcastSocket('refreshView', { view: 'systems' });
        this._broadcastSocket('refreshView', { view: 'comms' });
        this._renderView('systems');
      });
    }

    // Remove System buttons
    contentEl.querySelectorAll('[data-action="remove-system"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const current = this._getSystemsData();
        current.splice(idx, 1);
        await game.settings.set('wy-terminal', 'shipSystems', current);
        this._broadcastSocket('refreshView', { view: 'systems' });
        this._broadcastSocket('refreshView', { view: 'comms' });
        this._renderView('systems');
      });
    });
  }

  /* ── MU/TH/UR Chat Setup ── */
  _setupMuthurView(contentEl) {
    const mode = this.muthurBridge?.getMode() ?? 'relay';

    // IFRAME mode: embed external URL
    const muthurUrl = game.settings.get('wy-terminal', 'muthurUrl');
    if (mode === 'iframe' && muthurUrl) {
      this._embedMuthurIframe(contentEl, muthurUrl);
      return;
    }

    // Ensure bridge is created and callbacks are wired
    this._ensureMuthurBridge();

    // Built-in chat / engine mode
    const input = contentEl.querySelector('#wy-muthur-input');
    const sendBtn = contentEl.querySelector('[data-action="muthur-send"]');
    const output = contentEl.querySelector('#wy-muthur-output');

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._sendMuthurMessage(input.value);
          input.value = '';
        }
      });
      // Focus on render
      setTimeout(() => input.focus(), 100);
    }

    sendBtn?.addEventListener('click', () => {
      if (input?.value) {
        this._sendMuthurMessage(input.value);
        input.value = '';
        input.focus();
      }
    });

    // On-screen keyboard (touch-friendly)
    contentEl.querySelectorAll('.wy-osk-key').forEach(key => {
      key.addEventListener('click', (e) => {
        e.preventDefault();
        if (!input) return;
        const k = key.dataset.key;
        if (k === 'ENTER') {
          if (input.value.trim()) {
            this._sendMuthurMessage(input.value);
            input.value = '';
          }
        } else if (k === 'BACKSPACE') {
          input.value = input.value.slice(0, -1);
        } else {
          input.value += k;
        }
        input.focus();
      });
    });

    // Auto-scroll to bottom
    if (output) {
      output.scrollTop = output.scrollHeight;
    }
  }

  _embedMuthurIframe(contentEl, url) {
    contentEl.innerHTML = `
      <div class="wy-iframe-container">
        <iframe src="${url}" 
                allow="microphone; autoplay" 
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                title="MU/TH/UR AI Interface"></iframe>
      </div>
    `;
  }

  /**
   * Ensure the MuthurBridge is created and its callbacks are wired.
   */
  _ensureMuthurBridge() {
    if (this.muthurBridge) return;
    this.muthurBridge = new MuthurBridge(this.shipStatus);

    // Wire callbacks
    this.muthurBridge.onBroadcast = (message, sound) => {
      this.showAlert(message);
    };

    this.muthurBridge.onDisplay = (text, type) => {
      // Injected response from GM — display immediately (replace, don't accumulate)
      this.chatHistory = [{ type: type || 'muthur', text }];
      if (this.activeView === 'muthur') this._renderView('muthur');
    };

    this.muthurBridge.onGmCommand = (cmd) => {
      this._handleEngineGmCommand(cmd);
    };
  }

  /**
   * Check if MU/TH/UR AI is available (has API key or URL configured).
   */
  _isMuthurAvailable() {
    try {
      const url = game.settings.get('wy-terminal', 'muthurUrl');
      if (url) return true;
      const key = game.settings.get('wy-terminal', 'openaiApiKey');
      if (key) return true;
    } catch (e) {}
    return true;  // Always show — relay mode is always available
  }

  async _sendMuthurMessage(text) {
    if (!text.trim()) return;

    const userMsg = text.trim().toUpperCase();

    // Typing sound when player sends a message
    TerminalSFX.play('typeSend');

    // ── Check if input is a valid command code ──
    const codeResult = await this._tryCommandCodeInMuthur(userMsg);
    if (codeResult) {
      this.chatHistory = [{ type: 'muthur', text: codeResult }];
      TerminalSFX.play('typeResponse');
      this._renderView('muthur');

      // If access was granted and there's a previous query, resubmit it automatically
      if (codeResult.includes('RESTRICTED DATA UNLOCKED') && this._lastMuthurQuery) {
        // Brief delay so user sees the "ACCESS GRANTED" message first
        setTimeout(() => this._sendMuthurMessage(this._lastMuthurQuery), 1500);
      }
      return;
    }

    // Track this as the last real query (not a code attempt)
    this._lastMuthurQuery = userMsg;

    // Ensure bridge exists
    this._ensureMuthurBridge();

    // Clear screen and show processing indicator
    this.chatHistory = [{ type: 'system', text: 'PROCESSING QUERY...' }];
    this._renderView('muthur');

    try {
      const reply = await this.muthurBridge.sendMessage(userMsg);
      // Show only the response
      this.chatHistory = [{ type: 'muthur', text: reply }];
      // Response received sound
      TerminalSFX.play('typeResponse');
    } catch (err) {
      this.chatHistory = [{
        type: 'system',
        text: 'ERROR: UNABLE TO REACH MU/TH/UR. COMMUNICATIONS FAILURE.'
      }];
      TerminalSFX.play('buzz');
      console.error('WY-Terminal | MU/TH/UR communication error:', err);
    }

    this._renderView('muthur');
  }

  /**
   * Handle a GM command forwarded from the MuthurEngine.
   */
  _handleEngineGmCommand(cmd) {
    switch (cmd.type) {
      case 'clear_screen':
        this.chatHistory = [];
        if (this.activeView === 'muthur') this._renderView('muthur');
        break;

      case 'plugin_switched':
        this.chatHistory = [{
          type: 'system',
          text: `SCENARIO SWITCHED TO: ${cmd.plugin?.toUpperCase() || 'UNKNOWN'}`
        }];
        if (this.activeView === 'muthur') this._renderView('muthur');
        break;

      case 'start_self_destruct':
        // When triggered via MuthurEngine GM command, use dialog for armed-by
        this._showSelfDestructDialog();
        break;

      case 'cancel_self_destruct':
        this._cancelSelfDestruct();
        break;

      case 'update_crew_location':
      case 'assign_crew_task':
      case 'update_crew_status':
      case 'complete_crew_task':
      case 'update_ship_system':
      case 'add_log_entry':
      case 'set_game_time':
        // Forward to ship status manager
        if (this.shipStatus) {
          this.shipStatus.handleGmCommand(cmd);
          this.refreshCurrentView();
        }
        break;

      default:
        console.log('WY-Terminal | Unhandled engine GM command:', cmd.type);
    }
  }

  /* ── Scene View Setup ── */
  _setupScenesView(contentEl) {

    // ── Ship Selection Page (deck dropdown + ship cards) ──
    const shipSelectEl = contentEl.querySelector('#wy-ship-select');
    if (shipSelectEl) {
      shipSelectEl.querySelectorAll('.wy-deck-select').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const sceneId = e.target.value;
          if (!sceneId) return;
          TerminalSFX.play('beep');
          this.activeSceneId = sceneId;
          this._renderView('scenes');
        });
      });
      return; // Ship select page has no zoom / tokens / scene buttons
    }

    // ── Back button (player returning to ship selection) ──
    const backBtn = contentEl.querySelector('#wy-scene-back');
    if (backBtn) {
      backBtn.addEventListener('click', () => {
        TerminalSFX.play('beep');
        this.activeSceneId = null;
        this._renderView('scenes');
      });
    }

    // ── Deck/scene dropdown selector ──
    const dropdown = contentEl.querySelector('#wy-scene-dropdown');
    if (dropdown) {
      dropdown.addEventListener('change', (e) => {
        const sceneId = e.target.value;
        if (!sceneId) return;
        TerminalSFX.play('beep');
        this.activeSceneId = sceneId;
        this._renderView('scenes');
      });
    }

    // ── Push scene to players button (GM only) ──
    const pushBtn = contentEl.querySelector('#wy-scene-push');
    if (pushBtn) {
      pushBtn.addEventListener('click', () => {
        if (!this.activeSceneId) {
          ui.notifications.warn('Select a deck/scene first before pushing to players.');
          return;
        }
        TerminalSFX.play('beep');
        // Force all player terminals to switch to this scene
        this._broadcastSocket('sceneChange', { sceneId: this.activeSceneId });
        const scene = game.scenes?.get(this.activeSceneId);
        const name = scene?.name || this.activeSceneId;
        ui.notifications.info(`Pushed "${name}" to all Player-Terminals.`);
        console.log(`WY-Terminal | GM pushed scene ${name} to all player terminals`);
      });
    }

    // ── Sync tokens button (GM only) ──
    const refreshBtn = contentEl.querySelector('#wy-scene-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => {
        TerminalSFX.play('beep');
        // Re-render own scenes view to pick up latest tokens
        this._renderView('scenes');
        // Tell all player terminals to refresh their scenes view too
        this._broadcastSocket('refreshView', { view: 'scenes' });
        console.log('WY-Terminal | GM forced token sync on all terminals');
      });
    }

    // Clean up previous scene zoom handler (e.g. from token-update re-render)
    if (this._sceneZoom) {
      this._sceneZoom.destroy();
      this._sceneZoom = null;
    }
    if (this._sceneResizeObserver) {
      this._sceneResizeObserver.disconnect();
      this._sceneResizeObserver = null;
    }

    // Setup pinch-zoom on scene canvas — target the VIEWPORT so image + tokens zoom together
    const canvas = contentEl.querySelector('#wy-scene-canvas');
    const viewport = contentEl.querySelector('#wy-scene-viewport');
    const img = contentEl.querySelector('#wy-scene-img');
    const tokenLayer = contentEl.querySelector('#wy-token-layer');

    if (canvas && viewport && img) {
      const sceneZoom = new PinchZoomHandler(canvas, viewport);
      this._sceneZoom = sceneZoom;

      // Restore zoom state if we saved it before a re-render (e.g. token add/remove)
      if (this._savedZoomState) {
        sceneZoom.scale = this._savedZoomState.scale;
        sceneZoom.panX = this._savedZoomState.panX;
        sceneZoom.panY = this._savedZoomState.panY;
        sceneZoom._applyTransform();
        this._savedZoomState = null;
      }

      // Fit the token layer to the actual rendered image area (accounting for object-fit: contain)
      const fitTokens = () => this._fitTokenLayer(img, tokenLayer);

      if (img.complete && img.naturalWidth > 0) {
        fitTokens();
      } else {
        img.addEventListener('load', fitTokens);
      }

      // Refit token layer on container resize (viewport letterboxing changes)
      this._sceneResizeObserver = new ResizeObserver(fitTokens);
      this._sceneResizeObserver.observe(canvas);
    }

    // Setup token drag-to-move on the schematic
    this._setupTokenDrag(contentEl);
  }

  /* ── Token Drag-to-Move ── */

  /**
   * Set up mouse and touch drag handlers on tokens so users can reposition
   * them directly on the schematic. Coordinates are converted back to
   * Foundry scene pixel space and the token document is updated, which
   * syncs the move to all clients (including the FoundryVTT canvas).
   */
  _setupTokenDrag(contentEl) {
    const tokenLayer = contentEl.querySelector('#wy-token-layer');
    if (!tokenLayer) return;

    const tokenEls = tokenLayer.querySelectorAll('.wy-token');
    tokenEls.forEach(tokenEl => {
      const tokenId = tokenEl.dataset.tokenId;
      if (!tokenId) return;

      // Check if this user is allowed to move this token
      if (!this._canMoveToken(tokenId)) {
        tokenEl.classList.add('wy-drag-disabled');
        return;
      }

      // --- Mouse drag ---
      tokenEl.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation(); // Prevent PinchZoomHandler pan
        this._startTokenDrag(tokenEl, tokenId, e.clientX, e.clientY);
      });

      // --- Touch drag ---
      tokenEl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        e.stopPropagation(); // Prevent PinchZoomHandler pan
        const touch = e.touches[0];
        this._startTokenDrag(tokenEl, tokenId, touch.clientX, touch.clientY);
      }, { passive: true });
    });
  }

  /**
   * Check whether the current user is allowed to move a given token.
   * GM can move any token; players can move tokens they own.
   */
  _canMoveToken(tokenId) {
    if (game.user.isGM) return true;
    const scene = game.scenes?.get(this.activeSceneId);
    if (!scene) return false;
    const tokenDoc = scene.tokens?.get(tokenId);
    if (!tokenDoc) return false;
    // Player owns the token's actor, or the token itself
    return tokenDoc.isOwner;
  }

  /**
   * Begin dragging a token. Attaches move/end listeners to the window
   * so dragging works even when the cursor leaves the token element.
   */
  _startTokenDrag(tokenEl, tokenId, startClientX, startClientY) {
    // Suppress PinchZoomHandler panning while dragging
    if (this._sceneZoom) this._sceneZoom.enabled = false;

    tokenEl.classList.add('wy-dragging');
    const tokenLayer = tokenEl.closest('#wy-token-layer');
    if (!tokenLayer) return;

    // Current position as percentage
    let currentPctX = parseFloat(tokenEl.style.left);
    let currentPctY = parseFloat(tokenEl.style.top);
    const layerW = tokenLayer.offsetWidth;
    const layerH = tokenLayer.offsetHeight;

    // Account for current zoom scale so pixel deltas map correctly
    const scale = this._sceneZoom?.scale || 1;

    let lastClientX = startClientX;
    let lastClientY = startClientY;

    const onMove = (clientX, clientY) => {
      const dx = (clientX - lastClientX) / scale;
      const dy = (clientY - lastClientY) / scale;
      lastClientX = clientX;
      lastClientY = clientY;

      // Convert pixel delta to percentage delta relative to token layer
      currentPctX += (dx / layerW) * 100;
      currentPctY += (dy / layerH) * 100;

      tokenEl.style.left = `${currentPctX}%`;
      tokenEl.style.top = `${currentPctY}%`;
    };

    const onMouseMove = (e) => onMove(e.clientX, e.clientY);
    const onTouchMove = (e) => {
      if (e.touches.length === 1) {
        e.preventDefault(); // Prevent scroll
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };

    const onEnd = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);

      tokenEl.classList.remove('wy-dragging');

      // Re-enable PinchZoomHandler panning
      if (this._sceneZoom) this._sceneZoom.enabled = true;

      // Convert final percentage position back to Foundry scene pixel coords and update
      this._commitTokenMove(tokenId, currentPctX, currentPctY);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
  }

  /**
   * Convert a percentage position on the token layer back to Foundry scene
   * pixel coordinates and update the token document. The update propagates
   * to all clients via Foundry's normal document sync + our refreshTokens hook.
   */
  async _commitTokenMove(tokenId, pctX, pctY) {
    const scene = game.scenes?.get(this.activeSceneId);
    if (!scene) return;

    // Determine scene-image dimensions and padding offset (same logic as _getSceneTokens)
    let padX = 0, padY = 0, imgW, imgH;
    try {
      const dims = scene.dimensions;
      if (dims?.sceneWidth > 0 && dims?.sceneHeight > 0) {
        padX = dims.sceneX || 0;
        padY = dims.sceneY || 0;
        imgW = dims.sceneWidth;
        imgH = dims.sceneHeight;
      }
    } catch { /* dimensions unavailable */ }

    if (!imgW || !imgH) {
      imgW = scene.width || 1;
      imgH = scene.height || 1;
      const padding = scene.padding ?? 0;
      padX = imgW * padding;
      padY = imgH * padding;
    }

    // Reverse the percentage conversion:  pct = ((px - pad) / imgDim) * 100
    //   =>  px = (pct / 100) * imgDim + pad
    const newX = (pctX / 100) * imgW + padX;
    const newY = (pctY / 100) * imgH + padY;

    const tokenDoc = scene.tokens?.get(tokenId);
    if (!tokenDoc) return;

    try {
      // GM can update directly; player updates go through normal Foundry permissions
      await tokenDoc.update({ x: Math.round(newX), y: Math.round(newY) });
      console.log(`WY-Terminal | Token ${tokenId} moved to (${Math.round(newX)}, ${Math.round(newY)})`);
    } catch (err) {
      // If direct update fails (permission denied), ask GM to move it via socket
      if (!game.user.isGM) {
        console.log('WY-Terminal | Direct update denied, requesting GM to move token');
        game.socket.emit('module.wy-terminal', {
          type: 'moveToken',
          payload: {
            sceneId: this.activeSceneId,
            tokenId,
            x: Math.round(newX),
            y: Math.round(newY),
          },
        });
      } else {
        console.error('WY-Terminal | Failed to move token:', err);
        ui.notifications?.warn('UNABLE TO RELOCATE CREW MEMBER.');
      }
      // Revert to server position until the update round-trips back
      this.scheduleTokenUpdate(null);
    }
  }

  /**
   * Position and size the token overlay layer to exactly match the rendered image area
   * within the viewport. Accounts for object-fit: contain letterboxing so that
   * percentage-based token coordinates line up with the actual image pixels.
   */
  _fitTokenLayer(img, tokenLayer) {
    if (!img || !tokenLayer) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    if (!natW || !natH) return;

    const boxW = img.clientWidth;
    const boxH = img.clientHeight;
    if (!boxW || !boxH) return;

    const imgAspect = natW / natH;
    const boxAspect = boxW / boxH;

    let renderW, renderH, offsetX, offsetY;
    if (imgAspect > boxAspect) {
      // Image wider than box — full width, letterboxed vertically
      renderW = boxW;
      renderH = boxW / imgAspect;
      offsetX = 0;
      offsetY = (boxH - renderH) / 2;
    } else {
      // Image taller than box — full height, letterboxed horizontally
      renderH = boxH;
      renderW = boxH * imgAspect;
      offsetX = (boxW - renderW) / 2;
      offsetY = 0;
    }

    tokenLayer.style.left = `${offsetX}px`;
    tokenLayer.style.top = `${offsetY}px`;
    tokenLayer.style.width = `${renderW}px`;
    tokenLayer.style.height = `${renderH}px`;
  }

  /* ── Star Systems View Setup ── */
  _setupStarSystemsView(contentEl) {
    const listView = contentEl.querySelector('#wy-ss-list-view');
    const detailView = contentEl.querySelector('#wy-ss-detail-view');
    const formEl = contentEl.querySelector('#wy-ss-form');
    if (!listView) return;

    const data = this._starSystemsCache ?? { systems: [] };
    const allSystems = data.systems || [];

    // Populate filter dropdowns
    const territorySelect = contentEl.querySelector('#wy-ss-filter-territory');
    const sectorSelect = contentEl.querySelector('#wy-ss-filter-sector');
    const statusSelect = contentEl.querySelector('#wy-ss-filter-status');
    if (territorySelect) {
      const territories = [...new Set(allSystems.map(s => s.territory))].sort();
      territories.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t.toUpperCase();
        territorySelect.appendChild(opt);
      });
    }
    if (sectorSelect) {
      const sectors = [...new Set(allSystems.map(s => s.sector).filter(Boolean))].sort();
      sectors.forEach(sec => {
        const opt = document.createElement('option');
        opt.value = sec;
        opt.textContent = sec.toUpperCase();
        sectorSelect.appendChild(opt);
      });
    }
    if (statusSelect) {
      const statuses = [...new Set(allSystems.map(s => s.status))].sort();
      statuses.forEach(st => {
        const opt = document.createElement('option');
        opt.value = st;
        opt.textContent = st.toUpperCase();
        statusSelect.appendChild(opt);
      });
    }

    // Populate datalists for territory/sector autocomplete in the form
    const territoryDL = contentEl.querySelector('#wy-ss-territory-list');
    const sectorDL = contentEl.querySelector('#wy-ss-sector-list');
    if (territoryDL) {
      [...new Set(allSystems.map(s => s.territory).filter(Boolean))].sort().forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        territoryDL.appendChild(opt);
      });
    }
    if (sectorDL) {
      [...new Set(allSystems.map(s => s.sector).filter(Boolean))].sort().forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        sectorDL.appendChild(opt);
      });
    }

    // Filter logic
    const applyFilter = () => {
      const tf = territorySelect?.value || 'ALL';
      const secf = sectorSelect?.value || 'ALL';
      const sf = statusSelect?.value || 'ALL';
      let visible = 0;
      contentEl.querySelectorAll('.wy-ss-row:not(.wy-ss-row-header)').forEach(row => {
        const matchT = tf === 'ALL' || row.dataset.ssTerritory === tf;
        const matchSec = secf === 'ALL' || row.dataset.ssSector === secf;
        const matchS = sf === 'ALL' || row.dataset.ssStatus === sf;
        const show = matchT && matchSec && matchS;
        row.style.display = show ? '' : 'none';
        if (show) visible++;
      });
      const countEl = contentEl.querySelector('#wy-ss-count');
      if (countEl) countEl.textContent = visible;
    };
    territorySelect?.addEventListener('change', applyFilter);
    sectorSelect?.addEventListener('change', applyFilter);
    statusSelect?.addEventListener('change', applyFilter);

    // Access / view buttons
    contentEl.querySelectorAll('[data-action="view-starsystem"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.ssId;
        this._showStarSystemDetail(contentEl, id);
      });
    });

    // Back button
    contentEl.querySelector('[data-action="ss-back"]')?.addEventListener('click', () => {
      TerminalSFX.play('beep');
      if (listView) listView.style.display = '';
      listView.classList.remove('wy-hidden');
      if (detailView) detailView.style.display = 'none';
      if (formEl) formEl.classList.add('wy-hidden');
    });

    /* ── GM CRUD ── */
    if (!game.user.isGM || !formEl) return;

    // Inline EDIT from list rows
    contentEl.querySelectorAll('[data-action="ss-row-edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sysId = btn.dataset.ssId;
        const sys = allSystems.find(s => s.id === sysId);
        if (!sys) return;
        TerminalSFX.play('beep');
        this._ssEditingId = sysId;
        this._ssPopulateForm(contentEl, sys);
        const title = contentEl.querySelector('#wy-ss-form-title');
        if (title) title.textContent = 'EDIT STAR SYSTEM';
        formEl.classList.remove('wy-hidden');
        listView.classList.add('wy-hidden');
        if (detailView) detailView.style.display = 'none';
      });
    });

    // Inline DELETE from list rows
    contentEl.querySelectorAll('[data-action="ss-row-delete"]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const sysId = btn.dataset.ssId;
        const sys = allSystems.find(s => s.id === sysId);
        if (!sys) return;
        const confirmed = await Dialog.confirm({
          title: 'DELETE STAR SYSTEM',
          content: `<p style="color: var(--wy-green); font-family: var(--wy-font, monospace); letter-spacing: 1px;">
            CONFIRM DELETION OF: <strong>${sys.name}</strong><br/>
            THIS ACTION CANNOT BE UNDONE.</p>`,
        });
        if (!confirmed) return;
        TerminalSFX.play('beep');
        await this._ssDeleteSystem(sysId);
        ui.notifications.info(`WY-Terminal: System "${sys.name}" deleted.`);
      });
    });

    // Track which system is being edited (null = create mode)
    this._ssEditingId = null;

    // CREATE button — show blank form
    contentEl.querySelector('[data-action="ss-create"]')?.addEventListener('click', () => {
      TerminalSFX.play('beep');
      this._ssEditingId = null;
      this._ssResetForm(contentEl);
      const title = contentEl.querySelector('#wy-ss-form-title');
      if (title) title.textContent = 'CREATE NEW STAR SYSTEM';
      formEl.classList.remove('wy-hidden');
      listView.classList.add('wy-hidden');
      if (detailView) detailView.style.display = 'none';
      formEl.scrollIntoView({ behavior: 'smooth' });
    });

    // EDIT button — populate form with current system
    contentEl.querySelector('[data-action="ss-edit"]')?.addEventListener('click', () => {
      const sysId = this._ssCurrentDetailId;
      if (!sysId) return;
      const sys = allSystems.find(s => s.id === sysId);
      if (!sys) return;
      TerminalSFX.play('beep');
      this._ssEditingId = sysId;
      this._ssPopulateForm(contentEl, sys);
      const title = contentEl.querySelector('#wy-ss-form-title');
      if (title) title.textContent = 'EDIT STAR SYSTEM';
      formEl.classList.remove('wy-hidden');
      listView.classList.add('wy-hidden');
      detailView.style.display = 'none';
    });

    // DELETE button
    contentEl.querySelector('[data-action="ss-delete"]')?.addEventListener('click', async () => {
      const sysId = this._ssCurrentDetailId;
      if (!sysId) return;
      const sys = allSystems.find(s => s.id === sysId);
      if (!sys) return;

      const confirmed = await Dialog.confirm({
        title: 'DELETE STAR SYSTEM',
        content: `<p style="color: var(--wy-green); font-family: var(--wy-font, monospace); letter-spacing: 1px;">
          CONFIRM DELETION OF: <strong>${sys.name}</strong><br/>
          THIS ACTION CANNOT BE UNDONE.</p>`,
      });
      if (!confirmed) return;

      TerminalSFX.play('beep');
      await this._ssDeleteSystem(sysId);
      ui.notifications.info(`WY-Terminal: System "${sys.name}" deleted.`);
    });

    // Add body row
    contentEl.querySelector('[data-action="ss-add-body"]')?.addEventListener('click', () => {
      this._ssAddBodyRow(contentEl);
    });

    // Cancel form
    contentEl.querySelector('[data-action="ss-form-cancel"]')?.addEventListener('click', () => {
      TerminalSFX.play('beep');
      formEl.classList.add('wy-hidden');
      listView.classList.remove('wy-hidden');
    });

    // Submit form (create or update)
    contentEl.querySelector('[data-action="ss-form-submit"]')?.addEventListener('click', async () => {
      const name = contentEl.querySelector('#wy-ss-form-name')?.value?.trim();
      if (!name) {
        ui.notifications.warn('WY-Terminal: System designation is required.');
        return;
      }

      const systemData = {
        name,
        type: contentEl.querySelector('#wy-ss-form-type')?.value || 'system',
        territory: contentEl.querySelector('#wy-ss-form-territory')?.value?.trim() || '',
        sector: contentEl.querySelector('#wy-ss-form-sector')?.value?.trim() || '',
        coordinates: contentEl.querySelector('#wy-ss-form-coordinates')?.value?.trim() || '',
        affiliation: contentEl.querySelector('#wy-ss-form-affiliation')?.value?.trim() || '',
        classification: contentEl.querySelector('#wy-ss-form-classification')?.value || 'NONE',
        status: contentEl.querySelector('#wy-ss-form-status')?.value || 'ACTIVE',
        description: contentEl.querySelector('#wy-ss-form-description')?.value?.trim() || '',
        bodies: this._ssCollectBodies(contentEl),
      };

      TerminalSFX.play('beep');

      if (this._ssEditingId) {
        await this._ssUpdateSystem(this._ssEditingId, systemData);
        ui.notifications.info(`WY-Terminal: System "${name}" updated.`);
      } else {
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '') + '_' + Date.now().toString(36);
        await this._ssCreateSystem({ ...systemData, id });
        ui.notifications.info(`WY-Terminal: System "${name}" created.`);
      }
    });
  }

  /* ── Star System Form Helpers ── */
  _ssResetForm(contentEl) {
    contentEl.querySelector('#wy-ss-form-name').value = '';
    contentEl.querySelector('#wy-ss-form-type').value = 'system';
    contentEl.querySelector('#wy-ss-form-territory').value = '';
    contentEl.querySelector('#wy-ss-form-sector').value = '';
    contentEl.querySelector('#wy-ss-form-coordinates').value = '';
    contentEl.querySelector('#wy-ss-form-affiliation').value = '';
    contentEl.querySelector('#wy-ss-form-classification').value = 'NONE';
    contentEl.querySelector('#wy-ss-form-status').value = 'ACTIVE';
    contentEl.querySelector('#wy-ss-form-description').value = '';
    const bodiesEl = contentEl.querySelector('#wy-ss-form-bodies');
    if (bodiesEl) bodiesEl.innerHTML = '';
  }

  _ssPopulateForm(contentEl, sys) {
    contentEl.querySelector('#wy-ss-form-name').value = sys.name || '';
    contentEl.querySelector('#wy-ss-form-type').value = sys.type || 'system';
    contentEl.querySelector('#wy-ss-form-territory').value = sys.territory || '';
    contentEl.querySelector('#wy-ss-form-sector').value = sys.sector || '';
    contentEl.querySelector('#wy-ss-form-coordinates').value = sys.coordinates || '';
    contentEl.querySelector('#wy-ss-form-affiliation').value = sys.affiliation || '';
    contentEl.querySelector('#wy-ss-form-classification').value = sys.classification || 'NONE';
    contentEl.querySelector('#wy-ss-form-status').value = sys.status || 'ACTIVE';
    contentEl.querySelector('#wy-ss-form-description').value = sys.description || '';
    const bodiesEl = contentEl.querySelector('#wy-ss-form-bodies');
    if (bodiesEl) {
      bodiesEl.innerHTML = '';
      (sys.bodies || []).forEach(b => this._ssAddBodyRow(contentEl, b));
    }
  }

  _ssAddBodyRow(contentEl, body = {}) {
    const container = contentEl.querySelector('#wy-ss-form-bodies');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'wy-ss-form-body-row';
    row.innerHTML = `
      <input type="text" class="wy-setting-input wy-ss-body-input-name" placeholder="Body name" value="${(body.name || '').replace(/"/g, '&quot;')}" />
      <select class="wy-setting-input wy-ss-body-input-type">
        <option value="planet" ${body.type === 'planet' ? 'selected' : ''}>PLANET</option>
        <option value="moon" ${body.type === 'moon' ? 'selected' : ''}>MOON</option>
        <option value="star" ${body.type === 'star' ? 'selected' : ''}>STAR</option>
        <option value="asteroid" ${body.type === 'asteroid' ? 'selected' : ''}>ASTEROID</option>
        <option value="station" ${body.type === 'station' ? 'selected' : ''}>STATION</option>
        <option value="gas giant" ${body.type === 'gas giant' ? 'selected' : ''}>GAS GIANT</option>
        <option value="dwarf" ${body.type === 'dwarf' ? 'selected' : ''}>DWARF</option>
        <option value="ring" ${body.type === 'ring' ? 'selected' : ''}>RING</option>
        <option value="other" ${body.type === 'other' ? 'selected' : ''}>OTHER</option>
      </select>
      <input type="text" class="wy-setting-input wy-ss-body-input-detail" placeholder="Details..." value="${(body.detail || '').replace(/"/g, '&quot;')}" />
      <button class="wy-scene-btn wy-ss-body-remove-btn" title="Remove body">&times;</button>
    `;
    row.querySelector('.wy-ss-body-remove-btn')?.addEventListener('click', () => row.remove());
    container.appendChild(row);
  }

  _ssCollectBodies(contentEl) {
    const bodies = [];
    contentEl.querySelectorAll('.wy-ss-form-body-row').forEach(row => {
      const name = row.querySelector('.wy-ss-body-input-name')?.value?.trim();
      if (!name) return;
      bodies.push({
        name,
        type: row.querySelector('.wy-ss-body-input-type')?.value || 'planet',
        detail: row.querySelector('.wy-ss-body-input-detail')?.value?.trim() || '',
      });
    });
    return bodies;
  }

  /* ── Star System Persistence ── */
  async _ssCreateSystem(system) {
    const overrides = foundry.utils.deepClone(game.settings.get('wy-terminal', 'starSystemsData') ?? { added: [], modified: {}, deleted: [] });
    if (!overrides.added) overrides.added = [];
    overrides.added.push(system);
    await game.settings.set('wy-terminal', 'starSystemsData', overrides);
    await this._loadStarSystemsData();
    this._broadcastSocket('refreshView', { view: 'starsystems' });
    this._renderView('starsystems');
  }

  async _ssUpdateSystem(systemId, fields) {
    const overrides = foundry.utils.deepClone(game.settings.get('wy-terminal', 'starSystemsData') ?? { added: [], modified: {}, deleted: [] });
    if (!overrides.modified) overrides.modified = {};
    if (!overrides.added) overrides.added = [];

    // Check if this was a GM-added system
    const addedIdx = overrides.added.findIndex(s => s.id === systemId);
    if (addedIdx !== -1) {
      overrides.added[addedIdx] = { ...overrides.added[addedIdx], ...fields };
    } else {
      overrides.modified[systemId] = { ...(overrides.modified[systemId] || {}), ...fields };
    }

    await game.settings.set('wy-terminal', 'starSystemsData', overrides);
    await this._loadStarSystemsData();
    this._broadcastSocket('refreshView', { view: 'starsystems' });
    this._renderView('starsystems');
  }

  async _ssDeleteSystem(systemId) {
    const overrides = foundry.utils.deepClone(game.settings.get('wy-terminal', 'starSystemsData') ?? { added: [], modified: {}, deleted: [] });
    if (!overrides.added) overrides.added = [];
    if (!overrides.deleted) overrides.deleted = [];
    if (!overrides.modified) overrides.modified = {};

    // Check if this was a GM-added system
    const addedIdx = overrides.added.findIndex(s => s.id === systemId);
    if (addedIdx !== -1) {
      overrides.added.splice(addedIdx, 1);
    } else {
      // It's a base system — mark as deleted
      if (!overrides.deleted.includes(systemId)) overrides.deleted.push(systemId);
      delete overrides.modified[systemId];
    }

    await game.settings.set('wy-terminal', 'starSystemsData', overrides);
    await this._loadStarSystemsData();
    this._broadcastSocket('refreshView', { view: 'starsystems' });
    this._renderView('starsystems');
  }

  _showStarSystemDetail(contentEl, systemId) {
    const data = this._starSystemsCache ?? { systems: [] };
    const sys = (data.systems || []).find(s => s.id === systemId);
    if (!sys) return;

    // Track for GM edit/delete buttons
    this._ssCurrentDetailId = systemId;

    const clearance = this._getActiveClearance();
    const classified = !this._canAccessClassification(sys.classification, clearance);

    const listView = contentEl.querySelector('#wy-ss-list-view');
    const detailView = contentEl.querySelector('#wy-ss-detail-view');
    const headerEl = contentEl.querySelector('#wy-ss-detail-header');
    const bodyEl = contentEl.querySelector('#wy-ss-detail-body');
    if (!listView || !detailView || !headerEl || !bodyEl) return;

    TerminalSFX.play('beep');

    if (classified) {
      TerminalSFX.play('buzz');
      const required = this._requiredClearanceFor(sys.classification);
      headerEl.innerHTML = `<div class="wy-ss-detail-title wy-text-red">ACCESS DENIED</div>`;
      bodyEl.innerHTML = `
        <div class="wy-ss-classified-block">
          <div class="wy-ss-classified-icon">&#x26A0;</div>
          <div class="wy-ss-classified-msg">
            CLASSIFICATION: <span class="wy-text-red">${sys.classification}</span><br/>
            REQUIRED CLEARANCE: <span class="wy-text-red">${required}</span><br/><br/>
            THIS RECORD IS SEALED UNDER ICC DIRECTIVE.<br/>
            ENTER VALID COMMAND CODE TO ELEVATE CLEARANCE.
          </div>
        </div>`;
      listView.style.display = 'none';
      detailView.style.display = '';
      const formElC = contentEl.querySelector('#wy-ss-form');
      if (formElC) formElC.classList.add('wy-hidden');
      return;
    }

    // Accessible — render full detail
    const statusClass = this._starSystemStatusToClass(sys.status);
    const statusColor = statusClass === 'online' ? 'wy-text-green' :
      statusClass === 'warning' ? 'wy-text-amber' :
      statusClass === 'critical' ? 'wy-text-red' : 'wy-text-dim';

    headerEl.innerHTML = `<div class="wy-ss-detail-title">${sys.name}</div>`;

    let bodiesHtml = '';
    if (sys.bodies && sys.bodies.length) {
      bodiesHtml = `
        <div class="wy-ss-detail-section-title">CELESTIAL BODIES</div>
        <div class="wy-ss-bodies-list">
          ${sys.bodies.map(b => `
            <div class="wy-ss-body-item">
              <span class="wy-ss-body-name">${b.name}</span>
              <span class="wy-ss-body-type">${(b.type || '').toUpperCase()}</span>
              <div class="wy-ss-body-detail">${b.detail || '—'}</div>
            </div>
          `).join('')}
        </div>`;
    }

    bodyEl.innerHTML = `
      <table class="wy-data-table wy-ss-detail-table">
        <tbody>
          <tr><td class="wy-ss-label">DESIGNATION</td><td>${sys.name}</td></tr>
          <tr><td class="wy-ss-label">TYPE</td><td>${(sys.type || '').toUpperCase()}</td></tr>
          <tr><td class="wy-ss-label">TERRITORY</td><td>${sys.territory || '—'}</td></tr>
          <tr><td class="wy-ss-label">SECTOR</td><td>${sys.sector || '—'}</td></tr>
          <tr><td class="wy-ss-label">COORDINATES</td><td>${sys.coordinates || '—'}</td></tr>
          <tr><td class="wy-ss-label">AFFILIATION</td><td>${sys.affiliation || '—'}</td></tr>
          <tr><td class="wy-ss-label">STATUS</td><td class="${statusColor}">${sys.status || '—'}</td></tr>
        </tbody>
      </table>

      <div class="wy-ss-detail-section-title">DESCRIPTION</div>
      <div class="wy-ss-description">${(sys.description || '—').replace(/\n/g, '<br/>')}</div>

      ${bodiesHtml}
    `;

    listView.style.display = 'none';
    detailView.style.display = '';
    // Hide editor form if open
    const formEl = contentEl.querySelector('#wy-ss-form');
    if (formEl) formEl.classList.add('wy-hidden');
  }

  /* ── Nav View Setup — star map canvas overlay + NAV markers ── */
  _setupNavView(contentEl) {
    const container = contentEl.querySelector('#wy-nav-starmap');
    const img = contentEl.querySelector('#wy-nav-starmap-img');
    const canvas = contentEl.querySelector('#wy-nav-starmap-overlay');
    if (!container || !img || !canvas) return;

    // Marker type → color map
    const MARKER_COLORS = {
      WAYPOINT:    '#7fff00',
      STATION:     '#00ccff',
      PLANET:      '#ffcc00',
      HAZARD:      '#ff4444',
      SIGNAL:      '#ff66ff',
      ANOMALY:     '#ff8800',
      SHIP:        '#00ffaa',
      DEPARTURE:   '#4488ff',
      DESTINATION: '#ffaa00',
      PLAYER:      '#00ffff',
      CUSTOM:      '#ffffff',
    };

    // Marker type → symbol map
    const MARKER_SYMBOLS = {
      WAYPOINT:    '◆',
      STATION:     '■',
      PLANET:      '●',
      HAZARD:      '⚠',
      SIGNAL:      '※',
      ANOMALY:     '◎',
      SHIP:        '▲',
      DEPARTURE:   '⊙',
      DESTINATION: '⊕',
      PLAYER:      '△',
      CUSTOM:      '✦',
    };

    // Temp drag state for live marker repositioning
    let _dragTemp = null;

    // Local aliases for class-level route helpers
    const buildRoutePath = (m) => this._buildRoutePath(m);
    const getRouteSegments = (p) => this._getRouteSegments(p);
    const positionOnRoute = (p, pr) => this._positionOnRoute(p, pr);
    const projectOntoRoute = (p, px, py) => this._projectOntoRoute(p, px, py);

    const drawMarkers = () => {
      const iw = img.offsetWidth;
      const ih = img.offsetHeight;
      canvas.width = iw;
      canvas.height = ih;
      canvas.style.width = iw + 'px';
      canvas.style.height = ih + 'px';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const navData = this._getNavData();
      const markers = navData.navMarkers || [];

      // Apply live drag position if active
      if (_dragTemp) {
        const dm = markers.find(m => m.id === _dragTemp.id);
        if (dm) {
          dm.x = _dragTemp.x;
          dm.y = _dragTemp.y;
          if (_dragTemp.progress !== undefined) dm.progress = _dragTemp.progress;
        }
      }

      // Build full route path: DEPARTURE → WAYPOINT(s) → DESTINATION
      const routePath = buildRoutePath(markers);

      // Compute PLAYER positions from progress along route path
      markers.forEach(m => {
        if (m.type === 'PLAYER' && routePath.length >= 2 && m.progress !== undefined) {
          const pos = positionOnRoute(routePath, m.progress);
          m.x = pos.x;
          m.y = pos.y;
          m._angle = pos.angle;
        }
      });

      // ── Draw travel path line along route ──
      if (routePath.length >= 2) {
        const player = markers.find(m => m.type === 'PLAYER');
        const { segments, totalDist } = getRouteSegments(routePath);

        if (player && totalDist > 0) {
          const playerProgress = player.progress ?? 0;
          const targetDist = playerProgress * totalDist;
          let accumulated = 0;

          // Traversed portion — solid line
          ctx.strokeStyle = '#00ffff';
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = 0.4;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(routePath[0].x * iw, routePath[0].y * ih);

          for (const seg of segments) {
            if (accumulated + seg.dist >= targetDist) {
              // Partial segment up to player position
              const segT = seg.dist > 0 ? (targetDist - accumulated) / seg.dist : 0;
              const plPx = (seg.from.x + (seg.to.x - seg.from.x) * segT) * iw;
              const plPy = (seg.from.y + (seg.to.y - seg.from.y) * segT) * ih;
              ctx.lineTo(plPx, plPy);
              ctx.stroke();

              // Remaining portion — dashed line from player onward
              ctx.strokeStyle = '#556677';
              ctx.lineWidth = 0.8;
              ctx.globalAlpha = 0.3;
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(plPx, plPy);
              ctx.lineTo(seg.to.x * iw, seg.to.y * ih);
              accumulated += seg.dist;
              // Continue with remaining full segments
              const segIdx = segments.indexOf(seg);
              for (let i = segIdx + 1; i < segments.length; i++) {
                ctx.lineTo(segments[i].to.x * iw, segments[i].to.y * ih);
              }
              ctx.stroke();
              break;
            } else {
              ctx.lineTo(seg.to.x * iw, seg.to.y * ih);
              accumulated += seg.dist;
            }
          }
        } else {
          // Full dashed path (no player yet)
          ctx.strokeStyle = '#556677';
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = 0.4;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(routePath[0].x * iw, routePath[0].y * ih);
          for (let i = 1; i < routePath.length; i++) {
            ctx.lineTo(routePath[i].x * iw, routePath[i].y * ih);
          }
          ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // ── Draw all markers ──
      markers.forEach(m => {
        const mx = m.x * iw;
        const my = m.y * ih;
        const color = MARKER_COLORS[m.type] || MARKER_COLORS.CUSTOM;
        const isRoute = ['DEPARTURE', 'DESTINATION', 'PLAYER'].includes(m.type);
        const ringR = isRoute ? 7 : 5;
        const tickLen = isRoute ? 5 : 3;

        if (m.type === 'PLAYER') {
          // Ship triangle pointing along route path
          const angle = m._angle ?? 0;
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(angle);
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 6;
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.moveTo(6, 0);
          ctx.lineTo(-4, -3.5);
          ctx.lineTo(-4, 3.5);
          ctx.closePath();
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
          ctx.restore();
          // Outer ring
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = 0.3;
          ctx.beginPath();
          ctx.arc(mx, my, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        } else {
          // Outer ring
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.8;
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.arc(mx, my, ringR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // Inner ring for DEPARTURE / DESTINATION
          if (m.type === 'DEPARTURE' || m.type === 'DESTINATION') {
            ctx.strokeStyle = color;
            ctx.lineWidth = 0.6;
            ctx.globalAlpha = 0.5;
            ctx.beginPath();
            ctx.arc(mx, my, 3, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Crosshair ticks
          ctx.strokeStyle = color;
          ctx.lineWidth = 0.6;
          ctx.globalAlpha = 0.5;
          ctx.beginPath();
          ctx.moveTo(mx - tickLen, my); ctx.lineTo(mx - 1, my);
          ctx.moveTo(mx + 1, my); ctx.lineTo(mx + tickLen, my);
          ctx.moveTo(mx, my - tickLen); ctx.lineTo(mx, my - 1);
          ctx.moveTo(mx, my + 1); ctx.lineTo(mx, my + tickLen);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // Center dot
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = isRoute ? 5 : 3;
          ctx.beginPath();
          ctx.arc(mx, my, isRoute ? 2 : 1.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Label
        const symbol = MARKER_SYMBOLS[m.type] || '✦';
        ctx.fillStyle = color;
        ctx.font = `${isRoute ? 8 : 7}px monospace`;
        const labelText = `${symbol} ${m.label}`;
        ctx.fillText(labelText, mx + (isRoute ? 9 : 7), my + 2);
      });
    };

    if (img.complete) {
      try { drawMarkers(); } catch (err) { console.error('WY-Terminal | drawMarkers init error:', err); }
    } else {
      img.addEventListener('load', () => { try { drawMarkers(); } catch (err) { console.error('WY-Terminal | drawMarkers load error:', err); } });
    }

    // Clean up previous navZoom to avoid leaked window listeners
    if (this._navZoom) { try { this._navZoom.destroy(); } catch (_) {} }
    // Pinch-zoom on star map
    const navZoom = new PinchZoomHandler(container, img);
    this._navZoom = navZoom;
    // Redraw overlay when zoom changes
    const origTransform = navZoom._applyTransform?.bind(navZoom);
    if (origTransform) {
      navZoom._applyTransform = (...args) => {
        origTransform(...args);
        // Sync canvas transform with image
        canvas.style.transform = img.style.transform;
      };
    }

    /* ── GM NAV marker placement ── */
    if (game.user.isGM) {
      let placingMarker = false;
      const toggleBtn = contentEl.querySelector('#wy-nav-marker-toggle');
      const formEl = contentEl.querySelector('#wy-nav-marker-form');
      const labelInput = contentEl.querySelector('#wy-nav-marker-label');
      const typeSelect = contentEl.querySelector('#wy-nav-marker-type');
      const xInput = contentEl.querySelector('#wy-nav-marker-x');
      const yInput = contentEl.querySelector('#wy-nav-marker-y');
      const editIdInput = contentEl.querySelector('#wy-nav-marker-edit-id');
      const progressRow = contentEl.querySelector('#wy-nav-marker-progress-row');
      const progressInput = contentEl.querySelector('#wy-nav-marker-progress');
      const progressVal = contentEl.querySelector('#wy-nav-marker-progress-val');

      // Show/hide progress row when marker type changes
      typeSelect?.addEventListener('change', () => {
        if (progressRow) progressRow.style.display = typeSelect.value === 'PLAYER' ? '' : 'none';
      });
      progressInput?.addEventListener('input', () => {
        if (progressVal) progressVal.textContent = progressInput.value + '%';
      });

      // Toggle placement mode
      toggleBtn?.addEventListener('click', () => {
        placingMarker = !placingMarker;
        toggleBtn.classList.toggle('wy-active', placingMarker);
        container.classList.toggle('wy-marker-placing', placingMarker);
        if (!placingMarker && formEl) {
          formEl.style.display = 'none';
          editIdInput.value = '';
        }
      });

      // Track mousedown position to distinguish click vs drag
      let _mdX = 0, _mdY = 0;
      container.addEventListener('mousedown', (e) => { _mdX = e.clientX; _mdY = e.clientY; });

      // Click on star map to place marker (only when placement mode is active)
      container.addEventListener('click', (e) => {
        if (!placingMarker) return;
        // Ignore if mouse moved more than 5px (was a pan/drag)
        const dx = e.clientX - _mdX, dy = e.clientY - _mdY;
        if (Math.sqrt(dx * dx + dy * dy) > 5) return;

        const rect = container.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;

        // Reverse the zoom/pan transform to get image-local coords
        const imgX = (clickX - navZoom.panX) / navZoom.scale;
        const imgY = (clickY - navZoom.panY) / navZoom.scale;

        // Normalize to 0-1
        const normX = Math.max(0, Math.min(1, imgX / img.offsetWidth));
        const normY = Math.max(0, Math.min(1, imgY / img.offsetHeight));

        // Fill form
        xInput.value = normX.toFixed(6);
        yInput.value = normY.toFixed(6);
        editIdInput.value = '';
        labelInput.value = '';
        typeSelect.value = 'WAYPOINT';
        if (progressRow) progressRow.style.display = 'none';
        if (progressInput) progressInput.value = '0';
        if (progressVal) progressVal.textContent = '0%';
        if (formEl) {
          formEl.style.display = '';
          formEl.querySelector('.wy-section-title').textContent = 'NEW NAV MARKER';
        }
        labelInput?.focus();
      });

      // Save marker
      contentEl.querySelector('[data-action="save-nav-marker"]')?.addEventListener('click', async () => {
        const label = labelInput?.value?.trim().toUpperCase();
        if (!label) {
          ui.notifications.warn('WY-Terminal: Marker label is required.');
          return;
        }
        const type = typeSelect?.value || 'WAYPOINT';
        const x = parseFloat(xInput?.value);
        const y = parseFloat(yInput?.value);
        if (isNaN(x) || isNaN(y)) return;

        const navData = this._loadSetting('navData') || {};
        const markers = navData.navMarkers || [];
        const editId = editIdInput?.value;
        const progress = type === 'PLAYER'
          ? parseInt(progressInput?.value || '0') / 100
          : undefined;

        if (editId) {
          // Update existing marker
          const idx = markers.findIndex(m => m.id === editId);
          if (idx >= 0) {
            const updated = { ...markers[idx], label, type, x, y };
            if (progress !== undefined) updated.progress = progress;
            else delete updated.progress;
            markers[idx] = updated;
          }
        } else {
          // Add new marker
          const newMarker = {
            id: foundry.utils.randomID(),
            label,
            type,
            x,
            y,
          };
          if (progress !== undefined) newMarker.progress = progress;
          markers.push(newMarker);
        }

        navData.navMarkers = markers;
        await game.settings.set('wy-terminal', 'navData', navData);
        ui.notifications.info(`WY-Terminal: NAV marker "${label}" saved.`);

        // Reset form
        if (formEl) formEl.style.display = 'none';
        editIdInput.value = '';
        placingMarker = false;
        toggleBtn?.classList.remove('wy-active');
        container.classList.remove('wy-marker-placing');

        // Redraw and refresh marker list
        drawMarkers();
        this._broadcastSocket('refreshView', { view: 'nav' });
        this.render(true);
      });

      // Cancel marker placement
      contentEl.querySelector('[data-action="cancel-nav-marker"]')?.addEventListener('click', () => {
        if (formEl) formEl.style.display = 'none';
        editIdInput.value = '';
        if (progressRow) progressRow.style.display = 'none';
      });

      // Edit marker from list
      contentEl.querySelectorAll('[data-action="edit-nav-marker"]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.markerId;
          const navData = this._loadSetting('navData') || {};
          const markers = navData.navMarkers || [];
          const marker = markers.find(m => m.id === id);
          if (!marker) return;

          // Populate form for editing
          editIdInput.value = marker.id;
          labelInput.value = marker.label;
          typeSelect.value = marker.type || 'WAYPOINT';
          xInput.value = marker.x.toFixed(6);
          yInput.value = marker.y.toFixed(6);
          // Show/hide progress row for PLAYER type
          const isPlayerType = marker.type === 'PLAYER';
          if (progressRow) progressRow.style.display = isPlayerType ? '' : 'none';
          if (progressInput && isPlayerType) {
            progressInput.value = Math.round((marker.progress || 0) * 100);
            if (progressVal) progressVal.textContent = progressInput.value + '%';
          }
          if (formEl) {
            formEl.style.display = '';
            formEl.querySelector('.wy-section-title').textContent = 'EDIT NAV MARKER';
          }
          labelInput?.focus();
        });
      });

      // Delete marker from list
      contentEl.querySelectorAll('[data-action="delete-nav-marker"]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.markerId;
          const navData = this._loadSetting('navData') || {};
          const markers = navData.navMarkers || [];
          const idx = markers.findIndex(m => m.id === id);
          if (idx < 0) return;
          const label = markers[idx].label;
          markers.splice(idx, 1);
          navData.navMarkers = markers;
          await game.settings.set('wy-terminal', 'navData', navData);
          ui.notifications.info(`WY-Terminal: NAV marker "${label}" deleted.`);
          drawMarkers();
          this._broadcastSocket('refreshView', { view: 'nav' });
          this.render(true);
        });
      });

      /* ── GM drag-to-move markers on star map ── */
      let dragMarker = null;

      // Clean up previous window-level drag handlers
      if (this._navDragMove) window.removeEventListener('mousemove', this._navDragMove);
      if (this._navDragEnd) window.removeEventListener('mouseup', this._navDragEnd);

      // Capture-phase mousedown: detect marker hit BEFORE PinchZoomHandler panning
      container.addEventListener('mousedown', (e) => {
        if (placingMarker || e.button !== 0) return;

        const rect = container.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const imgX = (clickX - navZoom.panX) / navZoom.scale;
        const imgY = (clickY - navZoom.panY) / navZoom.scale;

        // Hit-test markers
        const navData = this._loadSetting('navData') || {};
        const markers = navData.navMarkers || [];
        const routePath = buildRoutePath(markers);

        let hitMarker = null;
        for (const m of markers) {
          let screenX = m.x * img.offsetWidth;
          let screenY = m.y * img.offsetHeight;
          // Use computed position for PLAYER on route path
          if (m.type === 'PLAYER' && routePath.length >= 2 && m.progress !== undefined) {
            const pos = positionOnRoute(routePath, m.progress);
            screenX = pos.x * img.offsetWidth;
            screenY = pos.y * img.offsetHeight;
          }
          const dist = Math.sqrt((imgX - screenX) ** 2 + (imgY - screenY) ** 2);
          if (dist < 12) {
            hitMarker = { ...m };
            break;
          }
        }

        if (hitMarker) {
          dragMarker = hitMarker;
          e.stopImmediatePropagation();
          e.preventDefault();
          container.style.cursor = 'grabbing';
        }
      }, true); // capture phase fires before PinchZoomHandler

      // Mousemove: update marker position in real-time
      this._navDragMove = (e) => {
        if (!dragMarker) return;
        e.preventDefault();

        const rect = container.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const clickY = e.clientY - rect.top;
        const imgX = (clickX - navZoom.panX) / navZoom.scale;
        const imgY = (clickY - navZoom.panY) / navZoom.scale;
        const normX = Math.max(0, Math.min(1, imgX / img.offsetWidth));
        const normY = Math.max(0, Math.min(1, imgY / img.offsetHeight));

        // For PLAYER: project onto route path through waypoints
        const navData = this._loadSetting('navData') || {};
        const markers = navData.navMarkers || [];
        const routePath = buildRoutePath(markers);

        if (dragMarker.type === 'PLAYER' && routePath.length >= 2) {
          const proj = projectOntoRoute(routePath, normX, normY);
          dragMarker.progress = proj.progress;
          dragMarker.x = proj.x;
          dragMarker.y = proj.y;
        } else {
          dragMarker.x = normX;
          dragMarker.y = normY;
        }

        _dragTemp = { id: dragMarker.id, x: dragMarker.x, y: dragMarker.y, progress: dragMarker.progress };
        drawMarkers();
      };
      window.addEventListener('mousemove', this._navDragMove);

      // Mouseup: persist final position
      this._navDragEnd = async (e) => {
        if (!dragMarker) return;
        container.style.cursor = '';

        const navData = this._loadSetting('navData') || {};
        const markers = navData.navMarkers || [];
        const idx = markers.findIndex(m => m.id === dragMarker.id);
        if (idx >= 0) {
          markers[idx].x = dragMarker.x;
          markers[idx].y = dragMarker.y;
          if (dragMarker.progress !== undefined) {
            markers[idx].progress = dragMarker.progress;
          }
          navData.navMarkers = markers;
          await game.settings.set('wy-terminal', 'navData', navData);
          this._broadcastSocket('refreshView', { view: 'nav' });
        }

        dragMarker = null;
        _dragTemp = null;
        drawMarkers();
        this.render(true);
      };
      window.addEventListener('mouseup', this._navDragEnd);
    }

    // Live ETA countdown ticker — reads from default NAV ETA timer by ID
    // At 10x game speed, the minutes digit changes every ~6 real seconds
    const etaEl = contentEl.querySelector('#wy-nav-eta-display');
    if (etaEl) {
      const etaTimer = this._getActiveTimers().find(t => t.id === DEFAULT_NAV_ETA_ID);
      if (etaTimer && etaTimer.remainingMs > 0) {
        let lastText = '';
        let lastTag = '';
        this._navEtaInterval = setInterval(() => {
          const timer = this._getActiveTimers().find(t => t.id === DEFAULT_NAV_ETA_ID);
          if (timer && timer.remainingMs > 0) {
            const paused = game.settings.get('wy-terminal', 'gameClockPaused') ?? false;
            const text = this._formatDuration(timer.remainingMs);
            const tag = paused ? 'PAUSED' : 'LIVE';
            if (text !== lastText || tag !== lastTag) {
              lastText = text;
              lastTag = tag;
              const tagColor = paused ? 'var(--wy-amber)' : 'var(--wy-green-dim)';
              etaEl.innerHTML = `${text} <span style="font-size: 10px; color: ${tagColor};">[${tag}]</span>`;
            }
          } else {
            etaEl.textContent = 'ARRIVED';
            clearInterval(this._navEtaInterval);
          }
        }, 1000);
      }
    }
  }

  /* ── Crew View Setup — List/Detail with clearance gate ── */
  _setupCrewView(contentEl) {
    const listView = contentEl.querySelector('#wy-crew-list-view');
    const detailView = contentEl.querySelector('#wy-crew-detail-view');
    
    // Cache crew data for detail lookup
    this._currentCrew = this._getCrewData();

    // Store which crew member was clicked
    let pendingCrewIndex = null;

    // [VIEW] button handler
    contentEl.querySelectorAll('[data-action="view-crew"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.crewIndex);
        pendingCrewIndex = idx;

        // GM bypasses command code
        if (game.user.isGM) {
          this._showCrewDetail(contentEl, idx);
          return;
        }

        // Check if current clearance grants crew access (MEDICAL or higher)
        const clearance = this._getActiveClearance();
        if (this._getClearanceRank(clearance) >= 1) {
          this._showCrewDetail(contentEl, idx);
          return;
        }

        // No clearance — show ACCESS DENIED overlay (player must use CMD CODE view)
        this._showClearanceOverlay(
          'ACCESS DENIED',
          'COMMAND CODE REQUIRED \u2014 USE CMD CODE TO AUTHORIZE',
          { currentClearance: clearance }
        );
      });
    });

    // [CLOSE] button in detail view
    contentEl.querySelector('[data-action="close-crew"]')?.addEventListener('click', () => {
      detailView?.classList.add('wy-hidden');
      listView?.classList.remove('wy-hidden');
    });

    // GM: Save crew member edits (status & location)
    contentEl.querySelector('[data-action="save-crew-edit"]')?.addEventListener('click', async () => {
      if (!game.user.isGM || pendingCrewIndex == null) return;
      const member = this._currentCrew[pendingCrewIndex];
      if (!member) return;

      const newStatus = contentEl.querySelector('#wy-crew-edit-status')?.value || 'ACTIVE';
      const newLocation = contentEl.querySelector('#wy-crew-edit-location')?.value?.trim().toUpperCase() || 'UNKNOWN';
      const newShip = contentEl.querySelector('#wy-crew-edit-ship')?.value || '';

      // Write ship assignment directly to the actor flag (source of truth)
      if (member.actorId) {
        const actor = game.actors.get(member.actorId);
        if (actor) {
          if (newShip) {
            await actor.setFlag('wy-terminal', 'shipAssignment', newShip);
          } else {
            await actor.unsetFlag('wy-terminal', 'shipAssignment');
          }
        }
      }

      // Load overrides array, find or create entry for this crew member by name
      let overrides = this._loadSetting('crewRoster');
      const nameKey = (member.name || '').toUpperCase();
      let idx = overrides.findIndex(o => (o.name || '').toUpperCase() === nameKey);
      if (idx < 0) {
        overrides.push({ name: nameKey });
        idx = overrides.length - 1;
      }

      const statusClass = this._crewStatusToClass(newStatus);
      const statusTextClass = statusClass === 'online' ? 'wy-text-green' :
        statusClass === 'warning' ? 'wy-text-amber' : 'wy-text-red';

      overrides[idx] = {
        ...overrides[idx],
        name: nameKey,
        status: newStatus,
        location: newLocation,
        shipAssignment: newShip,
        statusClass,
        statusTextClass,
      };

      await game.settings.set('wy-terminal', 'crewRoster', overrides);
      ui.notifications.info(`WY-Terminal: ${nameKey} updated — ${newStatus} / ${newLocation}`);

      // Refresh
      this._currentCrew = this._getCrewData();
      this._broadcastSocket('refreshView', { view: 'crew' });
      this._showCrewDetail(contentEl, pendingCrewIndex);
    });
  }

  _showCrewDetail(contentEl, crewIndex) {
    const crew = this._currentCrew[crewIndex];
    if (!crew) return;

    const listView = contentEl.querySelector('#wy-crew-list-view');
    const detailView = contentEl.querySelector('#wy-crew-detail-view');

    // Populate detail header
    const nameEl = contentEl.querySelector('#wy-crew-detail-name');
    const roleEl = contentEl.querySelector('#wy-crew-detail-role');
    const locationEl = contentEl.querySelector('#wy-crew-detail-location');
    const statusEl = contentEl.querySelector('#wy-crew-detail-status');
    const portraitEl = contentEl.querySelector('#wy-crew-detail-portrait');
    const detailBody = contentEl.querySelector('#wy-crew-detail-body');

    if (nameEl) nameEl.textContent = crew.name || 'UNKNOWN';
    if (roleEl) roleEl.textContent = (crew.isSynthetic ? '[ SYNTHETIC ] ' : '') + (crew.role || 'UNASSIGNED');
    if (locationEl) locationEl.textContent = crew.location || 'UNKNOWN';

    // Ship assignment display
    const shipEl = contentEl.querySelector('#wy-crew-detail-ship');
    if (shipEl) {
      if (crew.shipAssignment) {
        const profile = SHIP_PROFILES[crew.shipAssignment];
        shipEl.textContent = profile ? profile.name : crew.shipAssignment.toUpperCase();
      } else {
        shipEl.textContent = 'UNASSIGNED';
      }
    }
    if (statusEl) {
      statusEl.textContent = crew.status || 'UNKNOWN';
      statusEl.className = `wy-crew-det-status-val ${crew.statusTextClass || ''}`;
    }

    // Portrait — use actor img directly if available
    if (portraitEl) {
      const actorImg = crew.img || this._getCrewPortrait(crew.name);
      if (actorImg && actorImg !== 'icons/svg/mystery-man.svg') {
        portraitEl.src = actorImg;
        portraitEl.style.display = 'block';
      } else {
        portraitEl.style.display = 'none';
      }
    }

    // ── Vitals (Health / Stress / Radiation) ──
    const hasActorData = crew.health && crew.health.max > 0;

    const vitalsEl = contentEl.querySelector('#wy-crew-vitals');
    if (vitalsEl) vitalsEl.style.display = hasActorData ? '' : 'none';

    if (hasActorData) {
      this._renderVitalBar(contentEl, '#wy-crew-health-bar', '#wy-crew-health-val',
        crew.health.value, crew.health.max, 'wy-bar-green');
      this._renderVitalBar(contentEl, '#wy-crew-stress-bar', '#wy-crew-stress-val',
        crew.stress.value, crew.stress.max, 'wy-bar-amber');
      this._renderVitalBar(contentEl, '#wy-crew-rad-bar', '#wy-crew-rad-val',
        crew.radiation.value, crew.radiation.max, 'wy-bar-red');
    }

    // ── Conditions (rendered as individual tags) ──
    const condEl = contentEl.querySelector('#wy-crew-conditions');
    const condList = contentEl.querySelector('#wy-crew-conditions-list');
    if (condEl && condList) {
      if (crew.conditions && crew.conditions.length > 0) {
        condList.innerHTML = crew.conditions.map(c =>
          `<span class="wy-cond-tag">${c}</span>`
        ).join('');
        condEl.style.display = '';
      } else {
        condEl.style.display = 'none';
      }
    }

    // ── Attributes ──
    const statsEl = contentEl.querySelector('#wy-crew-stats');
    if (statsEl) statsEl.style.display = hasActorData ? '' : 'none';
    if (hasActorData && crew.attributes) {
      const set = (id, v) => { const el = contentEl.querySelector(id); if (el) el.textContent = v; };
      set('#wy-crew-attr-str', crew.attributes.str);
      set('#wy-crew-attr-agl', crew.attributes.agl);
      set('#wy-crew-attr-wit', crew.attributes.wit);
      set('#wy-crew-attr-emp', crew.attributes.emp);
    }

    // ── Skills ──
    const skillsEl = contentEl.querySelector('#wy-crew-skills');
    if (skillsEl) skillsEl.style.display = hasActorData ? '' : 'none';
    if (hasActorData && crew.skills) {
      const set = (id, v) => { const el = contentEl.querySelector(id); if (el) el.textContent = v; };
      set('#wy-crew-sk-heavyMach', crew.skills.heavyMach);
      set('#wy-crew-sk-closeCbt', crew.skills.closeCbt);
      set('#wy-crew-sk-stamina', crew.skills.stamina);
      set('#wy-crew-sk-rangedCbt', crew.skills.rangedCbt);
      set('#wy-crew-sk-mobility', crew.skills.mobility);
      set('#wy-crew-sk-piloting', crew.skills.piloting);
      set('#wy-crew-sk-command', crew.skills.command);
      set('#wy-crew-sk-manipulation', crew.skills.manipulation);
      set('#wy-crew-sk-medicalAid', crew.skills.medicalAid);
      set('#wy-crew-sk-observation', crew.skills.observation);
      set('#wy-crew-sk-survival', crew.skills.survival);
      set('#wy-crew-sk-comtech', crew.skills.comtech);
    }

    // ── Personnel file text (appearance, agenda, relationships, notes) ──
    if (detailBody) {
      const lines = [];
      if (crew.appearance) lines.push(`PROFILE:\n${crew.appearance}`);
      if (crew.agenda) lines.push(`\nPERSONAL AGENDA:\n${crew.agenda}`);
      if (crew.buddy) lines.push(`\nBUDDY: ${crew.buddy}`);
      if (crew.rival) lines.push(`RIVAL: ${crew.rival}`);
      if (crew.sigItem) lines.push(`\nSIGNATURE ITEM: ${crew.sigItem}`);
      if (crew.armor > 0) lines.push(`ARMOR RATING: ${crew.armor}`);
      if (crew.specialization) lines.push(`SPECIALIZATION: ${crew.specialization}`);
      if (crew.bio) lines.push(`\n${crew.bio}`);
      // Notes — strip HTML tags if present (actor notes can contain HTML)
      if (crew.notes) {
        let notesText = crew.notes;
        if (notesText.includes('<')) {
          const tmp = document.createElement('div');
          tmp.innerHTML = notesText;
          notesText = tmp.textContent || tmp.innerText || '';
        }
        if (notesText.trim()) lines.push(`\nNOTES:\n${notesText.trim()}`);
      }
      detailBody.textContent = lines.join('\n') || 'NO ADDITIONAL PERSONNEL DATA ON FILE.';
    }

    // GM: populate edit fields with current crew member values
    if (game.user.isGM) {
      const editStatus = contentEl.querySelector('#wy-crew-edit-status');
      const editLocation = contentEl.querySelector('#wy-crew-edit-location');
      const editShip = contentEl.querySelector('#wy-crew-edit-ship');
      if (editStatus) editStatus.value = crew.status || 'ACTIVE';
      if (editLocation) {
        this._populateLocationDropdown(editLocation);
        editLocation.value = crew.location || 'UNKNOWN';
      }
      if (editShip) {
        editShip.value = crew.shipAssignment || '';
      }
    }

    listView?.classList.add('wy-hidden');
    detailView?.classList.remove('wy-hidden');
  }

  /**
   * Render a vital bar (health/stress/radiation).
   */
  _renderVitalBar(contentEl, barSelector, valSelector, current, max, colorClass) {
    const barEl = contentEl.querySelector(barSelector);
    const valEl = contentEl.querySelector(valSelector);
    if (valEl) valEl.textContent = `${current} / ${max}`;
    if (barEl) {
      const pct = max > 0 ? Math.round((current / max) * 100) : 0;
      barEl.innerHTML = `<span class="wy-bar-fill ${colorClass}" style="width: ${pct}%"></span>`;
    }
  }

  _getCrewPortrait(crewName) {
    // Search Foundry actors for matching character name
    if (!game.actors) return null;
    const name = (crewName || '').toUpperCase();
    const actor = game.actors.find(a => {
      const actorName = (a.name || '').toUpperCase();
      return actorName === name || actorName.includes(name) || name.includes(actorName);
    });
    return actor?.img || null;
  }

  /**
   * Map crew status string to a CSS indicator class.
   */
  _crewStatusToClass(status) {
    const s = (status || '').toUpperCase();
    if (['ACTIVE', 'ON DUTY'].includes(s)) return 'online';
    if (['OFF DUTY', 'RESTING', 'IN CRYO', 'INJURED', 'QUARANTINED', 'DETAINED'].includes(s)) return 'warning';
    if (['CRITICAL', 'MIA', 'KIA', 'UNKNOWN'].includes(s)) return 'critical';
    return 'online';
  }

  /**
   * Populate the GM location dropdown with ship-specific locations.
   */
  _populateLocationDropdown(selectEl) {
    const shipId = (game.settings.get('wy-terminal', 'activeShip') || 'montero').toLowerCase();
    selectEl.innerHTML = '';

    const UNIVERSAL = ['UNKNOWN', 'UMBILICAL', 'EXTERNAL'];

    const MONTERO = [
      'BRIDGE',
      'MEDLAB',
      'GALLERY',
      'CRYO',
    ];

    const CRONUS = [
      // DECK D
      '(DECK D) VEHICLE BAY',
      // DECK C
      '(DECK C) REACTOR',
      '(DECK C) JUNCTION C-2',
      '(DECK C) CARGO BAY 1',
      '(DECK C) CARGO BAY 2',
      '(DECK C) CARGO OFFICE',
      '(DECK C) JUNCTION C-1',
      '(DECK C) FORWARD',
      '(DECK C) AFT',
      // DECK B
      '(DECK B) BRIDGE',
      '(DECK B) JUNCTION B-1',
      '(DECK B) VESTIBULE 1',
      '(DECK B) VESTIBULE 2',
      '(DECK B) MESS HALL',
      '(DECK B) CORPORATE SUITE',
      '(DECK B) LIVING AREA',
      '(DECK B) JUNCTION B-2',
      '(DECK B) MEDLAB',
      '(DECK B) SCI LAB 2',
      '(DECK B) SCI LAB 1',
      '(DECK B) SCIENCE SECTOR',
      '(DECK B) FORWARD',
      '(DECK B) AFT',
      // DECK A
      '(DECK A) MU/TH/UR',
      '(DECK A) JUNCTION A-1',
      '(DECK A) EXAMINATION ROOM',
      '(DECK A) JUNCTION A-2',
      '(DECK A) CRYO SECTOR',
      '(DECK A) FORWARD',
      '(DECK A) AFT',
    ];

    // Helper to add an optgroup
    const addGroup = (label, items) => {
      const group = document.createElement('optgroup');
      group.label = label;
      items.forEach(loc => {
        const opt = document.createElement('option');
        opt.value = loc;
        opt.textContent = loc;
        group.appendChild(opt);
      });
      selectEl.appendChild(group);
    };

    addGroup('GENERAL', UNIVERSAL);
    addGroup('MONTERO', MONTERO);
    addGroup('CRONUS — DECK D', CRONUS.filter(l => l.startsWith('(DECK D)')));
    addGroup('CRONUS — DECK C', CRONUS.filter(l => l.startsWith('(DECK C)')));
    addGroup('CRONUS — DECK B', CRONUS.filter(l => l.startsWith('(DECK B)')));
    addGroup('CRONUS — DECK A', CRONUS.filter(l => l.startsWith('(DECK A)')));
  }

  /* ══════════════════════════════════════════════════════════════
     CARGO VIEW — List / Detail / GM Add-Edit-Delete
     ══════════════════════════════════════════════════════════════ */
  _setupCargoView(contentEl) {
    this._currentCargo = this._getCargoData();
    this._editingCargoIdx = null;
    this._currentDetailCargo = null;

    const listView   = contentEl.querySelector('#wy-cargo-list-view');
    const detailView = contentEl.querySelector('#wy-cargo-detail-view');
    const form       = contentEl.querySelector('#wy-cargo-form');

    // ── [VIEW] detail ──
    contentEl.querySelectorAll('[data-action="view-cargo"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.cargoIdx, 10);
        const item = this._currentCargo[idx];
        if (!item) return;
        this._currentDetailCargo = { ...item, idx };
        this._showCargoDetail(contentEl, item);
        listView?.classList.add('wy-hidden');
        detailView?.classList.remove('wy-hidden');
      });
    });

    // ── [CLOSE] detail ──
    contentEl.querySelector('[data-action="close-cargo"]')?.addEventListener('click', () => {
      detailView?.classList.add('wy-hidden');
      listView?.classList.remove('wy-hidden');
      this._currentDetailCargo = null;
    });

    // ── GM: + ADD ITEM ──
    contentEl.querySelector('[data-action="add-cargo"]')?.addEventListener('click', () => {
      this._editingCargoIdx = null;
      const titleEl = contentEl.querySelector('#wy-cargo-form-title');
      if (titleEl) titleEl.textContent = 'ADD CARGO ITEM';
      contentEl.querySelector('#wy-cargo-form-name').value = '';
      contentEl.querySelector('#wy-cargo-form-qty').value = '1';
      contentEl.querySelector('#wy-cargo-form-category').value = 'EQUIPMENT';
      contentEl.querySelector('#wy-cargo-form-desc').value = '';
      form?.classList.remove('wy-hidden');
    });

    // ── GM: [EDIT] from detail ──
    contentEl.querySelector('[data-action="edit-cargo"]')?.addEventListener('click', () => {
      if (!this._currentDetailCargo) return;
      const item = this._currentDetailCargo;
      this._editingCargoIdx = item.idx;
      const titleEl = contentEl.querySelector('#wy-cargo-form-title');
      if (titleEl) titleEl.textContent = 'EDIT CARGO ITEM';
      contentEl.querySelector('#wy-cargo-form-name').value = item.name || '';
      contentEl.querySelector('#wy-cargo-form-qty').value = item.qty ?? 1;
      contentEl.querySelector('#wy-cargo-form-category').value = item.category || 'EQUIPMENT';
      const locSelect = contentEl.querySelector('#wy-cargo-form-location');
      if (locSelect) locSelect.value = item.location || 'UNKNOWN';
      contentEl.querySelector('#wy-cargo-form-desc').value = item.description || '';
      detailView?.classList.add('wy-hidden');
      form?.classList.remove('wy-hidden');
    });

    // ── GM: COMMIT (add or update) ──
    contentEl.querySelector('[data-action="submit-cargo"]')?.addEventListener('click', async () => {
      const name     = contentEl.querySelector('#wy-cargo-form-name')?.value?.trim().toUpperCase();
      const qty      = parseInt(contentEl.querySelector('#wy-cargo-form-qty')?.value, 10) || 1;
      const category = contentEl.querySelector('#wy-cargo-form-category')?.value || 'EQUIPMENT';
      const location = contentEl.querySelector('#wy-cargo-form-location')?.value || 'UNKNOWN';
      const description = contentEl.querySelector('#wy-cargo-form-desc')?.value?.trim() || '';
      if (!name) { ui.notifications.warn('Item name is required.'); return; }

      const cargo = [...this._currentCargo];
      const entry = { name, qty, category, location, description };

      if (this._editingCargoIdx !== null && this._editingCargoIdx < cargo.length) {
        cargo[this._editingCargoIdx] = entry;
        ui.notifications.info(`WY-Terminal: Updated ${name}`);
      } else {
        cargo.push(entry);
        ui.notifications.info(`WY-Terminal: Added ${name}`);
      }

      await game.settings.set('wy-terminal', 'cargoManifest', cargo);
      this._editingCargoIdx = null;
      form?.classList.add('wy-hidden');
      this._switchView('cargo');
      this._broadcastSocket('refreshView');
    });

    // ── GM: CANCEL form ──
    contentEl.querySelector('[data-action="cancel-cargo"]')?.addEventListener('click', () => {
      this._editingCargoIdx = null;
      form?.classList.add('wy-hidden');
    });

    // ── GM: [DEL] from detail ──
    contentEl.querySelector('[data-action="delete-cargo"]')?.addEventListener('click', async () => {
      if (!this._currentDetailCargo) return;
      const idx = this._currentDetailCargo.idx;
      const cargo = [...this._currentCargo];
      const removed = cargo.splice(idx, 1)[0];
      await game.settings.set('wy-terminal', 'cargoManifest', cargo);
      ui.notifications.info(`WY-Terminal: Removed ${removed?.name}`);
      this._currentDetailCargo = null;
      this._switchView('cargo');
      this._broadcastSocket('refreshView');
    });
  }

  /**
   * Populate cargo detail view elements.
   */
  _showCargoDetail(contentEl, item) {
    const nameEl  = contentEl.querySelector('#wy-cargo-detail-name');
    const badgeEl = contentEl.querySelector('#wy-cargo-detail-badge');
    const qtyEl   = contentEl.querySelector('#wy-cargo-detail-qty');
    const locEl   = contentEl.querySelector('#wy-cargo-detail-location');
    const bodyEl  = contentEl.querySelector('#wy-cargo-detail-body');

    if (nameEl)  nameEl.textContent = item.name;
    if (qtyEl)   qtyEl.textContent  = `QTY: ${item.qty}`;
    if (locEl)   locEl.textContent   = item.location || 'UNKNOWN';
    if (bodyEl)  bodyEl.textContent  = item.description || 'NO ADDITIONAL DATA ON FILE.';

    if (badgeEl) {
      badgeEl.textContent = item.category || 'EQUIPMENT';
      badgeEl.className = `wy-cargo-badge wy-cat-${item.category || 'EQUIPMENT'}`;
    }
  }

  /* ── Command Code View Setup ── */
  _setupCommandCodeView(contentEl) {
    const display = contentEl.querySelector('#wy-cc-keypad-display');
    let buffer = '';
    const MAX_DIGITS = 8;

    const updateDisplay = () => {
      if (display) display.textContent = buffer;
    };

    contentEl.querySelectorAll('[data-cc-keypad]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const val = btn.dataset.ccKeypad;

        if (val === 'clear') {
          buffer = '';
          updateDisplay();
          // Reset display style
          if (display) {
            display.style.color = '';
            display.style.borderColor = '';
          }
          return;
        }

        if (val === 'enter') {
          if (!buffer.length) return;

          // Validate code against the current user's command code (per-user)
          const userCode = this._loadUserCommandCode();

          if (userCode && userCode.code === buffer) {
            const role = (userCode.role || 'CREWMEMBER').toUpperCase();
            // Compare against the PLAYER clearance (not GM access level) so codes can elevate
            const currentRank = this._getClearanceRank(this._getPlayerClearance());
            const newRank = this._getClearanceRank(role);

            // Only upgrade clearance, never downgrade
            if (newRank > currentRank) {
              if (game.user.isGM) {
                await this._setActiveClearance(role);
              } else {
                // Players can't write world settings — ask GM via socket
                game.socket.emit('module.wy-terminal', {
                  type: 'setClearance',
                  payload: { level: role, userId: game.user.id },
                });
              }
            }

            // Visual feedback — green flash
            if (display) {
              display.textContent = `ACCESS GRANTED — ${role}`;
              display.style.color = 'var(--wy-green)';
              display.style.borderColor = 'var(--wy-green)';
            }

            // Play sound if available
            this._playSound?.('keypad-accept');

            // Update footer clearance in the main app element
            this._updateFooterClearance(role);

            // Update the current clearance display in this view
            const valueEl = contentEl.querySelector('.wy-cc-current-value');
            if (valueEl) {
              // Remove old level class
              valueEl.className = valueEl.className.replace(/wy-cc-level-\S+/g, '');
              valueEl.classList.add(`wy-cc-level-${role}`);
              valueEl.textContent = role;
            }

            // Broadcast to other clients
            this._broadcastSocket?.('refreshView', { view: 'commandcode' });

            // Clear buffer after delay
            setTimeout(() => {
              buffer = '';
              updateDisplay();
              if (display) {
                display.style.color = '';
                display.style.borderColor = '';
              }
            }, 2000);
          } else {
            // Invalid code — red flash
            if (display) {
              display.textContent = 'ACCESS DENIED';
              display.style.color = 'var(--wy-red)';
              display.style.borderColor = 'var(--wy-red)';
            }

            this._playSound?.('keypad-deny');

            setTimeout(() => {
              buffer = '';
              updateDisplay();
              if (display) {
                display.style.color = '';
                display.style.borderColor = '';
              }
            }, 1500);
          }
          return;
        }

        // Digit input
        if (buffer.length < MAX_DIGITS) {
          buffer += val;
          updateDisplay();
        }
      });
    });

    // ── Logout button — revoke clearance back to CREWMEMBER ──
    // Uses same pattern as command code elevation: socket to GM + local DOM update
    contentEl.querySelector('[data-action="logout-clearance"]')?.addEventListener('click', async () => {
      // Ask GM to write the setting via socket (players can't write world settings)
      game.socket.emit('module.wy-terminal', {
        type: 'setClearance',
        payload: { level: 'CREWMEMBER', userId: game.user.id },
      });

      // Update footer clearance display
      this._updateFooterClearance('CREWMEMBER');

      // Update the current clearance display in this view (direct DOM, no re-render)
      const valueEl = contentEl.querySelector('.wy-cc-current-value');
      if (valueEl) {
        valueEl.className = valueEl.className.replace(/wy-cc-level-\S+/g, '');
        valueEl.classList.add('wy-cc-level-CREWMEMBER');
        valueEl.textContent = 'CREWMEMBER';
      }

      // Broadcast to other clients
      this._broadcastSocket('clearanceUpdated', { level: 'CREWMEMBER', userId: game.user.id });
    });

    // ── GM Per-User Command Code Management ──
    if (game.user.isGM) {
      // Per-user clearance dropdowns — each row has [data-user-id] and [data-field="clearance"]
      contentEl.querySelectorAll('.wy-user-clearance-row [data-field="clearance"]').forEach(sel => {
        sel.addEventListener('change', async (e) => {
          const userId = e.target.closest('.wy-user-clearance-row')?.dataset?.userId;
          if (!userId) return;
          const newLevel = e.target.value;
          await this._setActiveClearance(newLevel, userId);
          // Broadcast so the target user's client updates
          this._broadcastSocket('clearanceUpdated', { level: newLevel, userId });
        });
      });

      // Save all user codes button
      contentEl.querySelector('[data-action="save-user-codes"]')?.addEventListener('click', async () => {
        const rows = contentEl.querySelectorAll('.wy-user-clearance-row');
        const codes = this._loadAllUserCommandCodes();
        const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
        let count = 0;
        rows.forEach(row => {
          const userId = row.dataset.userId;
          if (!userId) return;
          const role = row.querySelector('[data-field="role"]')?.value?.trim().toUpperCase() || 'CREWMEMBER';
          const code = (row.querySelector('[data-field="code"]')?.value?.trim() || '').slice(0, 8);
          const clearance = row.querySelector('[data-field="clearance"]')?.value || 'CREWMEMBER';
          codes[userId] = { code, role };
          levels[userId] = clearance;
          count++;
        });
        await game.settings.set('wy-terminal', 'userCommandCodes', codes);
        await game.settings.set('wy-terminal', 'userClearanceLevels', levels);
        ui.notifications.info(`WY-Terminal: ${count} user code(s) saved.`);
        // Broadcast so all clients pick up changes
        for (const row of rows) {
          const userId = row.dataset.userId;
          const clearance = row.querySelector('[data-field="clearance"]')?.value || 'CREWMEMBER';
          this._broadcastSocket('clearanceUpdated', { level: clearance, userId });
        }
        this._renderView('commandcode');
      });

      // Regenerate all codes button
      contentEl.querySelector('[data-action="regenerate-codes"]')?.addEventListener('click', async () => {
        const codes = this._loadAllUserCommandCodes();
        const rows = contentEl.querySelectorAll('.wy-user-clearance-row');
        rows.forEach(row => {
          const userId = row.dataset.userId;
          if (!userId) return;
          const newCode = Array.from({ length: 8 }, () => Math.floor(Math.random() * 10)).join('');
          const codeInput = row.querySelector('[data-field="code"]');
          if (codeInput) codeInput.value = newCode;
          // Update in-memory map
          if (!codes[userId]) codes[userId] = { code: newCode, role: 'CREWMEMBER' };
          else codes[userId].code = newCode;
        });
        await game.settings.set('wy-terminal', 'userCommandCodes', codes);
        ui.notifications.info('WY-Terminal: All command codes regenerated.');
        this._renderView('commandcode');
      });

      // Revoke all clearance button
      contentEl.querySelector('[data-action="revoke-all-clearance"]')?.addEventListener('click', async () => {
        const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
        for (const userId of Object.keys(levels)) {
          levels[userId] = 'CREWMEMBER';
        }
        await game.settings.set('wy-terminal', 'userClearanceLevels', levels);
        // Broadcast to all clients
        for (const userId of Object.keys(levels)) {
          this._broadcastSocket('clearanceUpdated', { level: 'CREWMEMBER', userId });
        }
        this._renderView('commandcode');
      });
    }
  }

  /* ── Comms Frequency Keypad Setup ── */
  _setupCommsView(contentEl) {
    const display = contentEl.querySelector('#wy-freq-keypad-display');
    let buffer = '';
    // ###.## = 6 chars total (3 digits + dot + 2 digits)
    const MAX_CHARS = 6;

    const updateDisplay = () => {
      if (display) display.textContent = buffer ? `${buffer} MHz` : '';
    };

    contentEl.querySelectorAll('[data-freq-keypad]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const val = btn.dataset.freqKeypad;

        if (val === 'clear') {
          buffer = '';
          updateDisplay();
          if (display) {
            display.style.color = '';
            display.style.borderColor = '';
          }
          return;
        }

        if (val === 'enter') {
          if (!buffer.length) return;

          // Validate strict ###.## format
          const valid = /^\d{3}\.\d{2}$/.test(buffer);
          if (!valid) {
            if (display) {
              display.textContent = 'INVALID FORMAT';
              display.style.color = 'var(--wy-red)';
              display.style.borderColor = 'var(--wy-red)';
            }
            this._playSound?.('keypad-deny');
            setTimeout(() => {
              buffer = '';
              updateDisplay();
              if (display) {
                display.style.color = '';
                display.style.borderColor = '';
              }
            }, 1500);
            return;
          }

          // Save frequency — GM writes directly, player asks via socket
          if (game.user.isGM) {
            await game.settings.set('wy-terminal', 'commFrequency', buffer);
          } else {
            game.socket.emit('module.wy-terminal', {
              type: 'setCommFrequency',
              payload: { frequency: buffer },
            });
          }

          // Visual feedback — green flash
          if (display) {
            display.textContent = `FREQUENCY SET: ${buffer} MHz`;
            display.style.color = 'var(--wy-green)';
            display.style.borderColor = 'var(--wy-green)';
          }
          this._playSound?.('keypad-accept');

          // Broadcast refresh to all clients
          this._broadcastSocket('refreshView', { view: 'comms' });

          setTimeout(() => {
            buffer = '';
            updateDisplay();
            if (display) {
              display.style.color = '';
              display.style.borderColor = '';
            }
            this.render();
          }, 2000);
          return;
        }

        // Decimal point
        if (val === '.') {
          if (buffer.includes('.')) return;     // Only one decimal
          if (buffer.length === 0) return;      // Don't start with decimal
          if (buffer.length > 3) return;        // Decimal must be at position 1-3
          buffer += '.';
          updateDisplay();
          return;
        }

        // Digit input
        if (buffer.length < MAX_CHARS) {
          // Auto-insert decimal after 3rd digit if not already present
          if (buffer.length === 3 && !buffer.includes('.')) {
            buffer += '.';
          }
          // Enforce max 2 digits after decimal
          const dotIdx = buffer.indexOf('.');
          if (dotIdx !== -1 && buffer.length - dotIdx > 2) return;

          buffer += val;
          updateDisplay();
        }
      });
    });
  }

  /* ── Game Clock View Setup ── */
  _setupGameClockView(contentEl) {
    // Live-tick the clock display every second
    const dateEl = contentEl.querySelector('#wy-clock-date');
    const timeEl = contentEl.querySelector('#wy-clock-time');

    const tickClock = () => {
      const { dateStr, timeStr } = this._getGameClockDate();
      if (dateEl) dateEl.textContent = dateStr;
      if (timeEl) timeEl.textContent = timeStr;
    };
    this._clockInterval = setInterval(tickClock, 1000);

    // GM adjustment buttons
    if (game.user.isGM) {
      contentEl.querySelectorAll('[data-clock-adjust]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const unit = btn.dataset.clockAdjust;   // year, month, day, hour, minute
          const dir = parseInt(btn.dataset.clockDir, 10); // +1 or -1

          // Freeze the clock: compute current game time, then re-anchor
          const { date } = this._getGameClockDate();

          switch (unit) {
            case 'year':   date.setUTCFullYear(date.getUTCFullYear() + dir); break;
            case 'month':  date.setUTCMonth(date.getUTCMonth() + dir); break;
            case 'day':    date.setUTCDate(date.getUTCDate() + dir); break;
            case 'hour':   date.setUTCHours(date.getUTCHours() + dir); break;
            case 'minute': date.setUTCMinutes(date.getUTCMinutes() + dir); break;
          }

          // Save new epoch + re-anchor to now
          await game.settings.set('wy-terminal', 'gameClockEpoch', date.getTime());
          await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());

          tickClock();
          this._broadcastSocket('refreshView', { view: 'all' });
        });
      });

      // Stop button — freeze game time
      const stopBtn = contentEl.querySelector('[data-clock-action="stop"]');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          // Snapshot current game time into epoch, then mark paused
          const { date } = this._getGameClockDate();
          await game.settings.set('wy-terminal', 'gameClockEpoch', date.getTime());
          await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
          await game.settings.set('wy-terminal', 'gameClockPaused', true);
          ui.notifications.info('WY-Terminal: Game clock STOPPED.');
          this._broadcastSocket('refreshView', { view: 'all' });
          this.render(true);
        });
      }

      // Start button — resume game time
      const startBtn = contentEl.querySelector('[data-clock-action="start"]');
      if (startBtn) {
        startBtn.addEventListener('click', async () => {
          // Re-anchor to now so clock resumes from frozen epoch
          await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
          await game.settings.set('wy-terminal', 'gameClockPaused', false);
          ui.notifications.info('WY-Terminal: Game clock STARTED.');
          this._broadcastSocket('refreshView', { view: 'all' });
          this.render(true);
        });
      }

      // Reset button
      const resetBtn = contentEl.querySelector('[data-clock-action="reset"]');
      if (resetBtn) {
        resetBtn.addEventListener('click', async () => {
          await game.settings.set('wy-terminal', 'gameClockEpoch', Date.UTC(2183, 5, 12, 6, 0, 0));
          await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
          await game.settings.set('wy-terminal', 'gameClockPaused', false);
          tickClock();
          this._broadcastSocket('refreshView', { view: 'all' });
          ui.notifications.info('WY-Terminal: Game clock reset to 2183-06-12 06:00.');
          this.render(true);
        });
      }
    }
  }

  /**
   * Clean up clock interval when leaving the view.
   */
  _clearClockInterval() {
    if (this._clockInterval) {
      clearInterval(this._clockInterval);
      this._clockInterval = null;
    }
  }

  /**
   * Dynamically update the footer clearance display without re-rendering.
   */
  _updateFooterClearance(level) {
    const el = this.element?.[0] || this.element;
    if (!el) return;
    const badge = el.querySelector('.wy-footer-clearance');
    if (!badge) return;
    badge.textContent = `CLEARANCE: ${level}`;
    badge.className = badge.className.replace(/wy-cc-level-\S+/g, '');
    badge.classList.add('wy-footer-clearance', `wy-cc-level-${level}`);
  }

  /**
   * Load the current user's command code entry.
   * @param {string} [userId] - optional user ID (defaults to current user)
   * @returns {{ code: string, role: string } | null}
   */
  _loadUserCommandCode(userId = null) {
    try {
      const codes = game.settings.get('wy-terminal', 'userCommandCodes') || {};
      return codes[userId || game.user.id] || null;
    } catch { return null; }
  }

  /**
   * Load all per-user command codes (GM management).
   * @returns {Object} map of userId → { code, role }
   */
  _loadAllUserCommandCodes() {
    try {
      return game.settings.get('wy-terminal', 'userCommandCodes') || {};
    } catch { return {}; }
  }

  /**
   * Legacy: load the old shared command codes array.
   * @deprecated Use _loadUserCommandCode() instead.
   */
  _loadCommandCodes() {
    try {
      const codes = game.settings.get('wy-terminal', 'commandCodes');
      return Array.isArray(codes) ? codes : [];
    } catch {
      return [];
    }
  }

  /* ── Clearance Level Helpers ── */
  static CLEARANCE_RANK = { 'NONE': 0, 'CREWMEMBER': 0, 'MEDICAL': 1, 'CAPTAIN': 2, 'CORPORATE': 3, 'MASTER_OVERRIDE': 4 };

  _getActiveClearance() {
    if (game.user.isGM) return 'MASTER_OVERRIDE';
    try {
      const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
      return levels[game.user.id] || 'CREWMEMBER';
    } catch { return 'CREWMEMBER'; }
  }

  /**
   * Get the player-facing clearance level (stored setting).
   * Unlike _getActiveClearance(), this does NOT auto-elevate for GM.
   * Used for display in footer and CMD CODE view so GM sees the actual player state.
   */
  _getPlayerClearance() {
    try {
      const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
      return levels[game.user.id] || 'CREWMEMBER';
    } catch { return 'CREWMEMBER'; }
  }

  _getClearanceRank(level) {
    return WYTerminalApp.CLEARANCE_RANK[level] ?? 0;
  }

  async _setActiveClearance(level, userId = null) {
    const targetId = userId || game.user.id;
    const levels = game.settings.get('wy-terminal', 'userClearanceLevels') || {};
    levels[targetId] = level;
    await game.settings.set('wy-terminal', 'userClearanceLevels', levels);
  }

  /**
   * Check if a log classification is accessible at the given clearance.
   * MEDICAL clearance → can view MEDICAL
   * CAPTAIN → all except SENSITIVE, RESTRICTED, CORPORATE
   * CORPORATE → everything
   * MASTER_OVERRIDE → everything, no codes needed
   */
  _canAccessClassification(classification, clearance) {
    if (!classification || classification === 'SYSTEM' || classification === 'MU/TH/UR') return true;
    const rank = this._getClearanceRank(clearance);
    if (rank >= 4) return true; // MASTER_OVERRIDE
    if (rank >= 3) return true; // CORPORATE sees all
    if (rank >= 2) {
      // CAPTAIN: blocked by SENSITIVE, RESTRICTED, CORPORATE
      return !['SENSITIVE', 'RESTRICTED', 'CORPORATE'].includes(classification);
    }
    if (rank >= 1) {
      // MEDICAL: only MEDICAL and unclassified
      return classification === 'MEDICAL';
    }
    // NONE: only unclassified
    return false;
  }

  /**
   * Determine required clearance level for a log classification.
   */
  _requiredClearanceFor(classification) {
    if (!classification || classification === 'SYSTEM' || classification === 'MU/TH/UR') return 'NONE';
    if (classification === 'MEDICAL') return 'MEDICAL';
    if (classification === 'PERSONAL') return 'CAPTAIN';
    if (['SENSITIVE', 'RESTRICTED', 'CORPORATE'].includes(classification)) return 'CORPORATE';
    return 'NONE';
  }

  /**
   * Check if user input is a valid command code in MU/TH/UR chat.
   * If matched with CORPORATE or MASTER_OVERRIDE, elevate clearance.
   * @param {string} input - uppercase user input
   * @returns {string|null} response text if code matched, null otherwise
   */
  async _tryCommandCodeInMuthur(input) {
    // Only check strings that look like command codes (8 digits)
    if (!/^\d{8}$/.test(input)) return null;

    // Validate against the current user's command code (per-user)
    const userCode = this._loadUserCommandCode();

    if (!userCode || userCode.code !== input) {
      TerminalSFX.play('buzz');
      return 'INVALID COMMAND CODE.\nACCESS DENIED.';
    }

    const role = (userCode.role || 'CREWMEMBER').toUpperCase();
    const rank = this._getClearanceRank(role);

    // Only CORPORATE (3) or MASTER_OVERRIDE (4) unlocks restricted data
    if (rank < 3) {
      TerminalSFX.play('buzz');
      return `COMMAND CODE ACCEPTED.\nCLEARANCE LEVEL: ${role}\n\nINSUFFICIENT CLEARANCE.\nCORPORATE OR MASTER OVERRIDE AUTHORIZATION REQUIRED.`;
    }

    // Elevate clearance (compare against player clearance, not GM access level)
    const currentRank = this._getClearanceRank(this._getPlayerClearance());
    if (rank > currentRank) {
      if (game.user.isGM) {
        await this._setActiveClearance(role);
      } else {
        game.socket.emit('module.wy-terminal', {
          type: 'setClearance',
          payload: { level: role, userId: game.user.id },
        });
      }
      this._updateFooterClearance(role);
    }

    TerminalSFX.play('keypad-accept');

    // Reset AI conversation history to clear stale denial patterns
    if (this.muthurBridge?.engine) {
      this.muthurBridge.engine.resetConversation();
    }

    return `COMMAND CODE VERIFIED.\nAUTHORIZATION: ${role}\n\nACCESS GRANTED.\nRESTRICTED DATA UNLOCKED.\n\nENTER QUERY.`;
  }

  /* ── Status View Setup — Emergency Countdown Tickers ── */
  _setupStatusView(contentEl) {
    const status = this.shipStatus?.getStatus() ?? {};

    // Self-destruct countdown ticker
    if (status.selfDestructActive) {
      this._selfDestructInterval = setInterval(() => {
        const remaining = this._getSelfDestructRemainingMs();
        const countdownEl = contentEl.querySelector('#wy-sd-countdown');
        if (countdownEl) {
          countdownEl.textContent = `T-${this._formatCountdown(remaining)}`;
        }
        // If countdown reached zero, show DETONATION
        if (remaining <= 0) {
          this._clearSelfDestructInterval();
          if (countdownEl) {
            countdownEl.textContent = 'DETONATION';
            countdownEl.classList.add('wy-text-blink');
          }
        }
      }, 1000);
    }

    // GM cancel buttons for active emergencies
    if (game.user.isGM) {
      contentEl.querySelectorAll('[data-cancel-emergency]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const action = e.currentTarget.dataset.cancelEmergency;
          this._handleEmergencyAction(action);
        });
      });
    }
  }

  _clearSelfDestructInterval() {
    if (this._selfDestructInterval) {
      clearInterval(this._selfDestructInterval);
      this._selfDestructInterval = null;
    }
  }

  /* ── Emergency View Setup ── */
  _setupEmergencyView(contentEl) {
    // Show clearance-check overlay for non-GM players
    if (!game.user.isGM) {
      const clearance = this._getActiveClearance();
      const rank = this._getClearanceRank(clearance);
      const hasAccess = rank >= 3; // CORPORATE or higher required
      const title = hasAccess ? 'ACCESS GRANTED' : 'ACCESS DENIED';
      const detail = hasAccess
        ? `CLEARANCE LEVEL: ${clearance}`
        : `INSUFFICIENT CLEARANCE \u2014 REQUIRES CORPORATE OR HIGHER`;
      this._showClearanceOverlay(title, detail, { currentClearance: clearance, granted: hasAccess });
    }

    contentEl.querySelectorAll('[data-emergency]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.currentTarget.dataset.emergency;
        this._handleEmergencyAction(action);
      });
    });

    // Live-tick the emergency view countdown if self-destruct is active
    const status = this.shipStatus?.getStatus() ?? {};
    if (status.selfDestructActive) {
      this._selfDestructInterval = setInterval(() => {
        const remaining = this._getSelfDestructRemainingMs();
        const countdownEl = contentEl.querySelector('#wy-emergency-sd-timer');
        if (countdownEl) {
          countdownEl.textContent = `T-${this._formatCountdown(remaining)}`;
        }
        if (remaining <= 0) {
          this._clearSelfDestructInterval();
          if (countdownEl) {
            countdownEl.textContent = 'DETONATION';
            countdownEl.classList.add('wy-text-blink');
          }
        }
      }, 1000);
    }
  }

  _handleEmergencyAction(action) {
    // GM-only actions — show dialog for who triggered
    switch (action) {
      case 'self-destruct':
        if (game.user.isGM) {
          this._showSelfDestructDialog();
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-self-destruct':
        if (game.user.isGM) this._cancelSelfDestruct();
        break;
      case 'evacuate':
        if (game.user.isGM) {
          this._showEmergencyTriggerDialog('EVACUATION PROTOCOL', 'evacuate');
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-evacuate':
        if (game.user.isGM) this._cancelEmergency('evacuate');
        break;
      case 'lockdown':
        if (game.user.isGM) {
          this._showEmergencyTriggerDialog('SHIP LOCKDOWN', 'lockdown');
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-lockdown':
        if (game.user.isGM) this._cancelEmergency('lockdown');
        break;
      case 'distress':
        if (game.user.isGM) {
          this._showEmergencyTriggerDialog('DISTRESS SIGNAL', 'distress');
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-distress':
        if (game.user.isGM) this._cancelEmergency('distress');
        break;
      case 'purge':
        if (game.user.isGM) {
          this._showAtmospherePurgeDialog();
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-purge':
        if (game.user.isGM) this._cancelEmergency('purge');
        break;
      case 'bioalert':
        if (game.user.isGM) {
          this._showBioalertDialog();
        } else {
          this._showClearanceOverlay('AUTHORIZATION REQUIRED', 'GM ACCESS ONLY \u2014 EMERGENCY PROTOCOLS RESTRICTED', { currentClearance: this._getActiveClearance() });
        }
        break;
      case 'cancel-bioalert':
        if (game.user.isGM) this._cancelEmergency('bioalert');
        break;
    }
  }

  /**
   * Show a FoundryVTT dialog for GM to set who armed the self-destruct
   * and optional countdown duration (default 10 game hours).
   */
  _showSelfDestructDialog() {
    const crew = this._getCrewData();
    const crewOptions = crew.map(c => `<option value="${c.name}">${c.name.toUpperCase()}</option>`).join('');

    const content = `
      <form style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-weight: bold;">ARMED BY:</label>
          <select name="armedBy" style="width: 100%; margin-top: 4px;">
            <option value="">-- SELECT CREW MEMBER --</option>
            ${crewOptions}
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </div>
        <div>
          <label style="font-weight: bold;">COUNTDOWN (HOURS):</label>
          <input type="number" name="hours" value="10" min="0" max="99" step="1"
                 style="width: 100%; margin-top: 4px;" />
          <p class="notes" style="margin-top: 2px; font-size: 11px;">
            Game-time hours (10:1 acceleration applies).
          </p>
        </div>
      </form>
    `;

    new Dialog({
      title: '⚠ ARM SELF-DESTRUCT SEQUENCE',
      content,
      buttons: {
        arm: {
          label: 'ARM SELF-DESTRUCT',
          icon: '<i class="fas fa-radiation"></i>',
          callback: (html) => {
            const armedBy = html.find('[name="armedBy"]').val() || 'UNKNOWN';
            const hours = parseFloat(html.find('[name="hours"]').val()) || 10;
            this._armSelfDestruct(armedBy, hours);
          },
        },
        cancel: {
          label: 'ABORT',
          icon: '<i class="fas fa-times"></i>',
        },
      },
      default: 'cancel',
    }).render(true);
  }

  /**
   * Arm self-destruct with real countdown tracking.
   * @param {string} armedBy — Name of crew member who armed the sequence
   * @param {number} hours — Countdown duration in game hours
   */
  _armSelfDestruct(armedBy, hours) {
    const durationMs = hours * 60 * 60 * 1000; // game-time ms
    const armedAtReal = Date.now(); // real-world anchor for countdown

    this.shipStatus?.update({
      selfDestructActive: true,
      selfDestructArmedBy: armedBy.toUpperCase(),
      selfDestructArmedAtReal: armedAtReal,
      selfDestructDurationMs: durationMs,
      selfDestructTimer: null, // legacy field, no longer used
    });

    // Create log entry
    const timerStr = `${String(Math.floor(hours)).padStart(2, '0')}:00:00`;
    this._addLog(
      'EMERGENCY',
      `SELF-DESTRUCT SEQUENCE ARMED BY: ${armedBy.toUpperCase()}`,
      'critical',
      `Self-destruct countdown initiated. T-${timerStr}. All personnel advised to evacuate immediately.`,
    );

    // Show persistent alert on all clients
    this.showAlert('SELF-DESTRUCT SEQUENCE INITIATED', 0);
    this._broadcastSocket('emergencyActivated', {
      protocol: 'self-destruct',
      message: 'SELF-DESTRUCT SEQUENCE INITIATED',
      triggeredBy: armedBy.toUpperCase(),
    });

    // Broadcast refreshes so player status/emergency views update + logs flash
    this._broadcastSocket('refreshView', { view: 'status' });
    this._broadcastSocket('refreshView', { view: 'emergency' });
    this._broadcastSocket('newLogAlert', {});

    this.refreshCurrentView();
  }

  /**
   * Cancel the self-destruct sequence.
   */
  _cancelSelfDestruct() {
    const status = this.shipStatus?.getStatus() ?? {};
    const armedBy = status.selfDestructArmedBy || 'UNKNOWN';

    this.shipStatus?.update({
      selfDestructActive: false,
      selfDestructArmedBy: null,
      selfDestructArmedAtReal: null,
      selfDestructDurationMs: null,
      selfDestructTimer: null,
    });

    // Create log entry
    this._addLog(
      'EMERGENCY',
      'SELF-DESTRUCT SEQUENCE CANCELLED',
      'warning',
      `Self-destruct sequence (armed by ${armedBy}) has been aborted.`,
    );

    // Check if any emergencies remain active
    const updatedStatus = this.shipStatus?.getStatus() ?? {};
    const anyRemaining = updatedStatus.evacuationActive || updatedStatus.lockdownActive ||
      updatedStatus.distressActive || updatedStatus.purgeActive || updatedStatus.bioalertActive;
    if (!anyRemaining) this.hideAlert();

    this._broadcastSocket('emergencyCancelled', { protocol: 'self-destruct', anyRemaining });

    // Speak abort announcement on the GM client (players get it via socket)
    this._speakWarning('ATTENTION. SELF-DESTRUCT SEQUENCE HAS BEEN ABORTED. RESUME NORMAL OPERATIONS.', { force: true });

    this._broadcastSocket('refreshView', { view: 'status' });
    this._broadcastSocket('refreshView', { view: 'emergency' });
    this._broadcastSocket('newLogAlert', {});

    this.refreshCurrentView();
  }

  /**
   * Compute remaining self-destruct countdown in ms.
   * Uses real-time anchor × 10 acceleration to match game clock.
   * Returns 0 if expired or not active.
   */
  _getSelfDestructRemainingMs() {
    const status = this.shipStatus?.getStatus() ?? {};
    if (!status.selfDestructActive) return 0;

    const armedAtReal = status.selfDestructArmedAtReal || 0;
    const durationMs = status.selfDestructDurationMs || 0;
    if (!armedAtReal || !durationMs) return 0;

    // Game-time elapsed = real elapsed × 10
    const realElapsed = Math.max(0, Date.now() - armedAtReal);
    const gameElapsed = realElapsed * 10;
    const remaining = Math.max(0, durationMs - gameElapsed);
    return remaining;
  }

  /**
   * Format milliseconds as HH:MM:SS countdown string.
   */
  _formatCountdown(ms) {
    if (ms <= 0) return '00:00:00';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* ══════════════════════════════════════════════════════════════════
     UNIFIED EMERGENCY PROTOCOL METHODS
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Emergency protocol config — maps action key → display info + shipStatus keys.
   */
  static EMERGENCY_PROTOCOLS = {
    evacuate: {
      label: 'EVACUATION PROTOCOL',
      sender: 'EMERGENCY',
      logArm: 'EVACUATION PROTOCOL ACTIVATED',
      logCancel: 'EVACUATION PROTOCOL CANCELLED',
      alertMessage: 'EVACUATION PROTOCOL — ALL PERSONNEL REPORT TO ESCAPE PODS',
      level: 'critical',
      activeKey: 'evacuationActive',
      triggeredByKey: 'evacuationTriggeredBy',
      icon: 'fa-running',
    },
    lockdown: {
      label: 'SHIP LOCKDOWN',
      sender: 'SECURITY',
      logArm: 'SHIP LOCKDOWN INITIATED — ALL AIRLOCKS SEALED',
      logCancel: 'SHIP LOCKDOWN LIFTED — DOORS UNSEALED',
      alertMessage: 'SHIP LOCKDOWN — ALL DOORS SEALED',
      level: 'warning',
      activeKey: 'lockdownActive',
      triggeredByKey: 'lockdownTriggeredBy',
      icon: 'fa-lock',
    },
    distress: {
      label: 'DISTRESS SIGNAL',
      sender: 'COMMS',
      logArm: 'DISTRESS SIGNAL BROADCAST ON ALL FREQUENCIES',
      logCancel: 'DISTRESS SIGNAL BROADCAST TERMINATED',
      alertMessage: 'DISTRESS SIGNAL BROADCASTING ON ALL FREQUENCIES',
      level: 'critical',
      activeKey: 'distressActive',
      triggeredByKey: 'distressTriggeredBy',
      icon: 'fa-satellite-dish',
    },
    purge: {
      label: 'ATMOSPHERE PURGE',
      sender: 'EMERGENCY',
      logArm: 'ATMOSPHERE PURGE INITIATED',
      logCancel: 'ATMOSPHERE PURGE CANCELLED — REPRESSURIZATION IN PROGRESS',
      alertMessage: 'ATMOSPHERE PURGE IN PROGRESS',
      level: 'critical',
      activeKey: 'purgeActive',
      triggeredByKey: 'purgeTriggeredBy',
      targetKey: 'purgeTarget',
      icon: 'fa-wind',
    },
    bioalert: {
      label: 'UNKNOWN BIOLOGICAL ORGANISM',
      sender: 'SCIENCE',
      logArm: 'UNKNOWN BIOLOGICAL ORGANISM DETECTED',
      logCancel: 'BIOLOGICAL ALERT CANCELLED — AREA CLEARED',
      alertMessage: 'UNKNOWN BIOLOGICAL ORGANISM DETECTED',
      level: 'critical',
      activeKey: 'bioalertActive',
      triggeredByKey: 'bioalertTriggeredBy',
      targetKey: 'bioalertTarget',
      icon: 'fa-biohazard',
    },
  };

  /**
   * Show a generic GM dialog for triggering an emergency protocol.
   * @param {string} title — Dialog title
   * @param {string} protocolKey — Key into EMERGENCY_PROTOCOLS
   */
  _showEmergencyTriggerDialog(title, protocolKey) {
    const crew = this._getCrewData();
    const crewOptions = crew.map(c => `<option value="${c.name}">${c.name.toUpperCase()}</option>`).join('');

    const content = `
      <form style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-weight: bold;">TRIGGERED BY:</label>
          <select name="triggeredBy" style="width: 100%; margin-top: 4px;">
            <option value="">-- SELECT CREW MEMBER --</option>
            ${crewOptions}
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </div>
      </form>
    `;

    const proto = WYTerminalApp.EMERGENCY_PROTOCOLS[protocolKey];

    new Dialog({
      title: `⚠ ${title}`,
      content,
      buttons: {
        activate: {
          label: `ACTIVATE ${title}`,
          icon: `<i class="fas ${proto?.icon || 'fa-exclamation-triangle'}"></i>`,
          callback: (html) => {
            const triggeredBy = html.find('[name="triggeredBy"]').val() || 'UNKNOWN';
            this._activateEmergency(protocolKey, triggeredBy);
          },
        },
        cancel: {
          label: 'ABORT',
          icon: '<i class="fas fa-times"></i>',
        },
      },
      default: 'cancel',
    }).render(true);
  }

  /**
   * Activate a generic emergency protocol.
   * @param {string} protocolKey — 'evacuate' | 'lockdown' | 'distress' | 'purge'
   * @param {string} triggeredBy — Crew member name
   * @param {string} [target] — For purge: deck/ship target
   */
  _activateEmergency(protocolKey, triggeredBy, target = '') {
    const proto = WYTerminalApp.EMERGENCY_PROTOCOLS[protocolKey];
    if (!proto) return;

    const updates = {
      [proto.activeKey]: true,
      [proto.triggeredByKey]: triggeredBy.toUpperCase(),
    };
    if (proto.targetKey && target) {
      updates[proto.targetKey] = target.toUpperCase();
    }
    this.shipStatus?.update(updates);

    // Log entry
    const logSubject = target
      ? `${proto.logArm} — ${target.toUpperCase()}`
      : `${proto.logArm} BY: ${triggeredBy.toUpperCase()}`;
    const logDetail = target
      ? `${proto.label} initiated by ${triggeredBy.toUpperCase()}. Target: ${target.toUpperCase()}.`
      : `${proto.label} initiated by ${triggeredBy.toUpperCase()}.`;
    this._addLog(proto.sender, logSubject, proto.level, logDetail);

    // Alert
    const alertMsg = target
      ? `${proto.alertMessage} — ${target.toUpperCase()}`
      : proto.alertMessage;
    this.showAlert(alertMsg, 0);
    this._broadcastSocket('emergencyActivated', {
      protocol: protocolKey,
      message: alertMsg,
      triggeredBy: triggeredBy.toUpperCase(),
      target: target.toUpperCase(),
    });

    // Broadcast refreshes
    this._broadcastSocket('refreshView', { view: 'status' });
    this._broadcastSocket('refreshView', { view: 'emergency' });
    this._broadcastSocket('newLogAlert', {});

    this.refreshCurrentView();
  }

  /**
   * Cancel a generic emergency protocol.
   * @param {string} protocolKey — 'evacuate' | 'lockdown' | 'distress' | 'purge'
   */
  _cancelEmergency(protocolKey) {
    const proto = WYTerminalApp.EMERGENCY_PROTOCOLS[protocolKey];
    if (!proto) return;

    const status = this.shipStatus?.getStatus() ?? {};
    const triggeredBy = status[proto.triggeredByKey] || 'UNKNOWN';
    const target = proto.targetKey ? (status[proto.targetKey] || '') : '';

    const updates = {
      [proto.activeKey]: false,
      [proto.triggeredByKey]: null,
    };
    if (proto.targetKey) updates[proto.targetKey] = null;
    this.shipStatus?.update(updates);

    // Log entry
    const logSubject = target
      ? `${proto.logCancel} — ${target}`
      : proto.logCancel;
    this._addLog(proto.sender, logSubject, 'info',
      `${proto.label} (triggered by ${triggeredBy}) has been cancelled.`);

    // Check if any emergencies remain active
    const updatedStatus = this.shipStatus?.getStatus() ?? {};
    const anyRemaining = updatedStatus.selfDestructActive || updatedStatus.evacuationActive ||
      updatedStatus.lockdownActive || updatedStatus.distressActive || updatedStatus.purgeActive || updatedStatus.bioalertActive;
    if (!anyRemaining) this.hideAlert();

    this._broadcastSocket('emergencyCancelled', { protocol: protocolKey, anyRemaining });
    this._broadcastSocket('refreshView', { view: 'status' });
    this._broadcastSocket('refreshView', { view: 'emergency' });
    this._broadcastSocket('newLogAlert', {});

    this.refreshCurrentView();
  }

  /**
   * Show atmosphere purge dialog with deck selection.
   */
  _showAtmospherePurgeDialog() {
    const crew = this._getCrewData();
    const crewOptions = crew.map(c => `<option value="${c.name}">${c.name.toUpperCase()}</option>`).join('');

    // Build deck options based on active ship
    const shipId = game.settings.get('wy-terminal', 'activeShip') || 'montero';
    let deckOptions = '<option value="ENTIRE SHIP">ENTIRE SHIP</option>';
    if (shipId === 'cronus') {
      deckOptions += `
        <option value="DECK A">DECK A — COMMAND / CRYO</option>
        <option value="DECK B">DECK B — CREW / SCIENCE</option>
        <option value="DECK C">DECK C — ENGINEERING / CARGO</option>
        <option value="DECK D">DECK D — VEHICLE BAY</option>
      `;
    }

    const content = `
      <form style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-weight: bold;">TRIGGERED BY:</label>
          <select name="triggeredBy" style="width: 100%; margin-top: 4px;">
            <option value="">-- SELECT CREW MEMBER --</option>
            ${crewOptions}
            <option value="UNKNOWN">UNKNOWN</option>
          </select>
        </div>
        <div>
          <label style="font-weight: bold;">PURGE TARGET:</label>
          <select name="purgeTarget" style="width: 100%; margin-top: 4px;">
            ${deckOptions}
          </select>
        </div>
      </form>
    `;

    new Dialog({
      title: '⚠ ATMOSPHERE PURGE',
      content,
      buttons: {
        activate: {
          label: 'INITIATE PURGE',
          icon: '<i class="fas fa-wind"></i>',
          callback: (html) => {
            const triggeredBy = html.find('[name="triggeredBy"]').val() || 'UNKNOWN';
            const target = html.find('[name="purgeTarget"]').val() || 'ENTIRE SHIP';
            this._activateEmergency('purge', triggeredBy, target);
          },
        },
        cancel: {
          label: 'ABORT',
          icon: '<i class="fas fa-times"></i>',
        },
      },
      default: 'cancel',
    }).render(true);
  }

  /**
   * Show the UNKNOWN BIOLOGICAL ORGANISM DETECTED dialog.
   * GM selects crew member, deck, and enters a free-text location/section.
   */
  _showBioalertDialog() {
    const content = `
      <form style="display: flex; flex-direction: column; gap: 12px;">
        <div>
          <label style="font-weight: bold;">DECK:</label>
          <input type="text" name="bioalertDeck" placeholder="e.g. DECK A, UPPER DECK, MAIN DECK"
            style="width: 100%; margin-top: 4px; text-transform: uppercase;" />
        </div>
        <div>
          <label style="font-weight: bold;">SECTION / LOCATION:</label>
          <input type="text" name="bioalertLocation" placeholder="e.g. CARGO BAY, MED-LAB, CORRIDOR 4"
            style="width: 100%; margin-top: 4px; text-transform: uppercase;" />
        </div>
      </form>
    `;

    new Dialog({
      title: '⚠ UNKNOWN BIOLOGICAL ORGANISM DETECTED',
      content,
      buttons: {
        activate: {
          label: 'CONFIRM DETECTION',
          icon: '<i class="fas fa-biohazard"></i>',
          callback: (html) => {
            const deck = (html.find('[name="bioalertDeck"]').val() || '').toUpperCase().trim();
            const location = (html.find('[name="bioalertLocation"]').val() || '').toUpperCase().trim();
            let target = '';
            if (deck && location) target = `${deck}, ${location}`;
            else if (deck) target = deck;
            else if (location) target = location;
            else target = 'UNKNOWN';
            this._activateEmergency('bioalert', 'SENSOR ARRAY', target);
          },
        },
        cancel: {
          label: 'ABORT',
          icon: '<i class="fas fa-times"></i>',
        },
      },
      default: 'cancel',
    }).render(true);
  }

  /**
   * Flash the STATUS nav button on player terminals until clicked.
   * Called via socket from GM when emergency is activated.
   */
  _flashStatusButton() {
    if (game.user.isGM) return;
    const el = this.element?.[0] ?? this.element;
    const statusBtn = el?.querySelector('[data-view="status"]');
    if (statusBtn && !statusBtn.classList.contains('wy-nav-flash-red')) {
      statusBtn.classList.add('wy-nav-flash-red');
    }
  }

  /**
   * Start the self-destruct computer voice warning system.
   * Speaks a warning every 60 real seconds on player clients.
   */
  _startSelfDestructVoice() {
    if (game.user?.isGM) return;
    this._clearSelfDestructVoice();

    // Immediate first warning
    this._speakWarning('WARNING. SELF-DESTRUCT SEQUENCE HAS BEEN INITIATED. EVACUATE IMMEDIATELY.');

    // Repeat every 60 real seconds
    this._selfDestructVoiceInterval = setInterval(() => {
      const remaining = this._getSelfDestructRemainingMs();
      if (remaining <= 0) {
        this._speakWarning('DETONATION IMMINENT.');
        this._clearSelfDestructVoice();
        return;
      }
      const totalSec = Math.floor(remaining / 1000);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      let timeAnnounce = '';
      if (h > 0) timeAnnounce += `${h} hour${h > 1 ? 's' : ''} `;
      if (m > 0) timeAnnounce += `${m} minute${m > 1 ? 's' : ''}`;
      if (!timeAnnounce) timeAnnounce = 'less than one minute';
      this._speakWarning(`WARNING. SELF-DESTRUCT IN ${timeAnnounce.trim()}. ALL PERSONNEL EVACUATE IMMEDIATELY.`);
    }, 60000);
  }

  /**
   * Stop the self-destruct voice warning interval.
   */
  _clearSelfDestructVoice() {
    if (this._selfDestructVoiceInterval) {
      clearInterval(this._selfDestructVoiceInterval);
      this._selfDestructVoiceInterval = null;
    }
  }

  /**
   * Start repeating voice warnings for a generic emergency protocol.
   * Speaks immediately, then every 60 real seconds on player clients.
   * @param {string} protocol — e.g. 'evacuate', 'lockdown', 'distress', 'purge', 'bioalert'
   * @param {string} message — The spoken warning text
   */
  _startEmergencyVoice(protocol, message) {
    if (game.user?.isGM) return;
    this._clearEmergencyVoice(protocol);

    // Immediate first warning
    this._speakWarning(message);

    // Initialize interval storage
    if (!this._emergencyVoiceIntervals) this._emergencyVoiceIntervals = {};

    // Repeat every 60 real seconds
    this._emergencyVoiceIntervals[protocol] = setInterval(() => {
      this._speakWarning(message);
    }, 60000);
  }

  /**
   * Stop voice warnings for a specific emergency protocol.
   * @param {string} protocol — Protocol key to stop
   */
  _clearEmergencyVoice(protocol) {
    if (this._emergencyVoiceIntervals?.[protocol]) {
      clearInterval(this._emergencyVoiceIntervals[protocol]);
      delete this._emergencyVoiceIntervals[protocol];
    }
  }

  /**
   * Stop all emergency voice warning intervals.
   */
  _clearAllEmergencyVoices() {
    this._clearSelfDestructVoice();
    if (!this._emergencyVoiceIntervals) return;
    for (const key of Object.keys(this._emergencyVoiceIntervals)) {
      clearInterval(this._emergencyVoiceIntervals[key]);
    }
    this._emergencyVoiceIntervals = {};
  }

  /**
   * Speak a warning using the Web Speech API.
   * Uses a robotic/low pitch voice for computer effect.
   * @param {string} text — The text to speak
   * @param {object} [opts] — Options
   * @param {boolean} [opts.force=false] — If true, speak even on the GM client
   */
  _speakWarning(text, { force = false } = {}) {
    if (!force && game.user?.isGM) return;
    try {
      if (!game.settings.get('wy-terminal', 'soundEnabled')) return;
    } catch { /* default enabled */ }

    if (!('speechSynthesis' in window)) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.85;
    utterance.pitch = 0.3;
    utterance.volume = 0.8;

    // Prefer a robotic-sounding voice if available
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v =>
      /microsoft|zira|david|mark|google/i.test(v.name) && v.lang.startsWith('en')
    ) || voices.find(v => v.lang.startsWith('en'));
    if (preferred) utterance.voice = preferred;

    speechSynthesis.cancel(); // Stop any in-progress speech
    speechSynthesis.speak(utterance);
  }

  /* ── Settings View Setup ── */
  _setupSettingsView(contentEl) {
    contentEl.querySelector('[data-action="save-settings"]')?.addEventListener('click', () => {
      this._saveSettingsFromForm(contentEl);
    });

    contentEl.querySelector('[data-action="reload-status"]')?.addEventListener('click', () => {
      this.shipStatus?.reload();
      ui.notifications.info('WY-Terminal: Ship status reloaded.');
      this.refreshCurrentView();
    });

    contentEl.querySelector('[data-action="clear-chat"]')?.addEventListener('click', () => {
      this.chatHistory = [];
      if (this.activeView === 'muthur') this._renderView('muthur');
      ui.notifications.info('WY-Terminal: Chat log cleared.');
    });

    // Save player terminal effects (scanlines, flicker, sound) — GM only control
    contentEl.querySelector('[data-action="save-player-effects"]')?.addEventListener('click', async () => {
      const effectInputs = contentEl.querySelectorAll('[data-player-effect]');
      for (const input of effectInputs) {
        const key = input.dataset.playerEffect;
        const value = input.type === 'checkbox' ? input.checked : input.value;
        try {
          await game.settings.set('wy-terminal', key, value);
        } catch (e) {
          console.warn(`WY-Terminal | Could not save player effect "${key}":`, e);
        }
      }
      ui.notifications.info('WY-Terminal: Player terminal effects saved.');
      // Broadcast full re-render so player terminals pick up CRT and sound changes
      this._broadcastSocket('refreshView', { view: 'all' });
    });

    // Reset game clock to default epoch (2183-06-12 06:00 UTC) + reset timers
    contentEl.querySelector('[data-action="reset-gameclock"]')?.addEventListener('click', async () => {
      await game.settings.set('wy-terminal', 'gameClockEpoch', Date.UTC(2183, 5, 12, 6, 0, 0));
      await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
      await game.settings.set('wy-terminal', 'gameClockPaused', false);
      await this._resetTimersToDefault();
      ui.notifications.info('WY-Terminal: Game clock and timers reset to defaults.');
      this.refreshCurrentView();
    });

    // Reset logs to defaults — clears all runtime/player-generated log entries
    contentEl.querySelector('[data-action="reset-logs"]')?.addEventListener('click', async () => {
      await game.settings.set('wy-terminal', 'logEntries', []);
      await this._loadFileLogEntries();
      ui.notifications.info('WY-Terminal: Logs reset to defaults.');
      this.refreshCurrentView();
    });

    // Reset crew roster to empty (will rebuild from Actor sheets)
    contentEl.querySelector('[data-action="reset-crew"]')?.addEventListener('click', async () => {
      await game.settings.set('wy-terminal', 'crewRoster', []);
      ui.notifications.info('WY-Terminal: Crew roster reset. Will rebuild from Actor sheets.');
      this.refreshCurrentView();
    });

    // Reset ship status — clears systems, cargo, and status data back to defaults
    contentEl.querySelector('[data-action="reset-shipstatus"]')?.addEventListener('click', async () => {
      await game.settings.set('wy-terminal', 'shipStatusData', {});
      await game.settings.set('wy-terminal', 'shipSystems', []);
      await game.settings.set('wy-terminal', 'cargoManifest', []);
      this.shipStatus?.reload();
      ui.notifications.info('WY-Terminal: Ship status, systems, and cargo reset to defaults.');
      this.refreshCurrentView();
    });

    // Reset ALL game settings at once
    contentEl.querySelector('[data-action="reset-all"]')?.addEventListener('click', async () => {
      await game.settings.set('wy-terminal', 'gameClockEpoch', Date.UTC(2183, 5, 12, 6, 0, 0));
      await game.settings.set('wy-terminal', 'gameClockRealAnchor', Date.now());
      await game.settings.set('wy-terminal', 'gameClockPaused', false);
      await game.settings.set('wy-terminal', 'logEntries', []);
      await this._loadFileLogEntries();
      await this._resetTimersToDefault();
      await game.settings.set('wy-terminal', 'crewRoster', []);
      await game.settings.set('wy-terminal', 'shipStatusData', {});
      await game.settings.set('wy-terminal', 'shipSystems', []);
      await game.settings.set('wy-terminal', 'cargoManifest', []);
      this.shipStatus?.reload();
      ui.notifications.info('WY-Terminal: All game settings reset to defaults.');
      this.refreshCurrentView();
    });

    // Ship profile switch — apply profile defaults to settings
    contentEl.querySelector('[data-action="switch-ship"]')?.addEventListener('click', async () => {
      const select = contentEl.querySelector('[data-setting="activeShip"]');
      if (!select) return;
      const newShipId = select.value;
      const profile = getShipProfile(newShipId);
      const oldShipId = game.settings.get('wy-terminal', 'activeShip');

      if (newShipId === oldShipId) {
        ui.notifications.warn('WY-Terminal: Already configured for this ship.');
        return;
      }

      // Save ship profile selection
      await game.settings.set('wy-terminal', 'activeShip', newShipId);

      // Apply profile defaults to ship identity settings
      await game.settings.set('wy-terminal', 'shipName', profile.name);
      await game.settings.set('wy-terminal', 'shipClass', profile.shipClass);
      await game.settings.set('wy-terminal', 'shipRegistry', profile.registry);
      await game.settings.set('wy-terminal', 'missionName', profile.mission);

      // Reset ship systems, crew, logs, and cargo to new profile defaults
      await game.settings.set('wy-terminal', 'shipSystems', []);
      await game.settings.set('wy-terminal', 'crewRoster', []);
      await game.settings.set('wy-terminal', 'logEntries', []);
      await game.settings.set('wy-terminal', 'cargoManifest', []);

      // Auto-switch scenario plugin to match ship profile
      if (profile.defaultPlugin) {
        await game.settings.set('wy-terminal', 'muthurPlugin', profile.defaultPlugin);
        if (this.muthurBridge?.engine) {
          try {
            await this.muthurBridge.engine.switchPlugin(profile.defaultPlugin);
          } catch (e) {
            console.warn('WY-Terminal | Plugin switch on ship change failed:', e);
          }
        }
      }

      // Reload file logs for the new ship profile
      await this._loadFileLogEntries();

      ui.notifications.info(`WY-Terminal: Ship switched to ${profile.name}. Systems, crew, and logs reset to defaults.`);

      // Broadcast to all clients so player terminals refresh
      this._broadcastSocket('shipSwitch', { shipId: newShipId, shipName: profile.name });
      this.render(true);
    });

    // Optimize FoundryVTT core settings for best WY-Terminal experience
    contentEl.querySelector('[data-action="optimize-foundry"]')?.addEventListener('click', async () => {
      try {
        // Disable distracting token/map behaviours
        await game.settings.set('core', 'tokenAutoRotate', false);
        await game.settings.set('core', 'tokenDragPreview', false);
        await game.settings.set('core', 'scrollingStatusText', false);

        // Restrict AV and cursor permissions
        const perms = foundry.utils.deepClone(game.settings.get('core', 'permissions'));
        perms.BROADCAST_AUDIO  = [3, 4];      // Assistant GM + GM only
        perms.BROADCAST_VIDEO  = [2, 3, 4];    // Trusted + Assistant GM + GM
        perms.SHOW_CURSOR      = [];            // Nobody
        await game.settings.set('core', 'permissions', perms);

        ui.notifications.info('WY-Terminal: FoundryVTT settings optimized for best experience.');
      } catch (e) {
        console.error('WY-Terminal | Failed to optimize FoundryVTT settings:', e);
        ui.notifications.error('WY-Terminal: Could not apply FoundryVTT optimizations. Check console.');
      }
    });

    // Save navigation data
    contentEl.querySelector('[data-action="save-nav"]')?.addEventListener('click', async () => {
      const navInputs = contentEl.querySelectorAll('[data-nav]');
      const navData = this._loadSetting('navData') || {};
      navInputs.forEach(input => {
        const field = input.dataset.nav;
        navData[field] = input.value.trim();
      });
      await game.settings.set('wy-terminal', 'navData', navData);

      // Update the default NAV ETA timer with the new ETA duration
      const etaDurationMs = this._parseEtaDuration(navData.eta);
      if (etaDurationMs > 0) {
        const dest = navData.destination?.trim().toUpperCase() || 'DESTINATION';
        const { date: gameNow } = this._getGameClockDate();
        await this._updateEventTimer(DEFAULT_NAV_ETA_ID, {
          label: `ARRIVAL AT ${dest}`,
          gameTargetTime: gameNow.getTime() + etaDurationMs,
          status: 'active',
          actions: this._buildDefaultEtaActions(dest),
        });
        // Clean up completed/cancelled state
        const timers = this._loadSetting('eventTimers') || [];
        const etaTimer = timers.find(t => t.id === DEFAULT_NAV_ETA_ID);
        if (etaTimer) {
          delete etaTimer.completedAt;
          delete etaTimer.cancelledAt;
          await game.settings.set('wy-terminal', 'eventTimers', timers);
        }
        ui.notifications.info(`WY-Terminal: Navigation saved. ETA timer set (${this._formatDuration(etaDurationMs)} game time).`);
      } else {
        ui.notifications.info('WY-Terminal: Navigation data saved.');
      }
      // Broadcast refresh so player terminals update
      this._broadcastSocket('refreshView', { view: 'nav' });
    });

    // Save ship access controls (which ships players can see)
    contentEl.querySelector('[data-action="save-ship-access"]')?.addEventListener('click', async () => {
      const checkboxes = contentEl.querySelectorAll('[data-ship-access]');
      const enabled = [];
      checkboxes.forEach(cb => {
        if (cb.checked) enabled.push(cb.dataset.shipAccess);
      });
      await game.settings.set('wy-terminal', 'enabledShips', enabled);
      ui.notifications.info(`WY-Terminal: Player ship access updated. ${enabled.length} ship(s) enabled.`);
      // Broadcast to players so their schematic selector updates immediately
      this._broadcastSocket('refreshView', { view: 'scenes' });
    });

    // Save crew folder selection (which Actor folders appear in CREW view)
    contentEl.querySelector('[data-action="save-crew-folders"]')?.addEventListener('click', async () => {
      const checkboxes = contentEl.querySelectorAll('[data-crew-folder]');
      const selected = [];
      checkboxes.forEach(cb => {
        if (cb.checked) selected.push(cb.dataset.crewFolder);
      });
      await game.settings.set('wy-terminal', 'crewFolders', selected);
      ui.notifications.info(`WY-Terminal: Crew folders updated. ${selected.length} folder(s) selected.`);
      this._broadcastSocket('refreshView', { view: 'crew' });
    });
  }

  async _saveSettingsFromForm(contentEl) {
    const inputs = contentEl.querySelectorAll('[data-setting]');
    for (const input of inputs) {
      const key = input.dataset.setting;
      let value;
      if (input.type === 'checkbox') {
        value = input.checked;
      } else if (input.type === 'password') {
        // Only save if user actually entered a new value (not the masked placeholder)
        if (input.value && !input.value.startsWith('••')) {
          value = input.value;
        } else {
          continue; // Skip — keep existing value
        }
      } else {
        value = input.value;
      }
      try {
        await game.settings.set('wy-terminal', key, value);
      } catch (e) {
        console.warn(`WY-Terminal | Could not save setting "${key}":`, e);
      }
    }

    // If plugin changed, reinitialize the engine
    if (this.muthurBridge?.engine) {
      const newPlugin = game.settings.get('wy-terminal', 'muthurPlugin');
      if (newPlugin !== this.muthurBridge.engine.pluginName) {
        try {
          await this.muthurBridge.engine.switchPlugin(newPlugin);
        } catch (e) {
          console.warn('WY-Terminal | Plugin switch failed:', e);
        }
      }
    }

    ui.notifications.info('WY-Terminal: Configuration saved.');
    // Broadcast full re-render so player terminals pick up CRT and other changes
    this._broadcastSocket('refreshView', { view: 'all' });
    this.render(true);
  }

  /* ══════════════════════════════════════════════════════════════════
     TIMERS VIEW — Dedicated event timer management interface
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Build view data for the Timers view.
   */
  _getTimersViewData() {
    const allTimers = this._getAllTimers() || [];
    const { date: gameNow } = this._getGameClockDate();
    const gameNowMs = gameNow.getTime();

    const activeTimers = allTimers
      .filter(t => t.status === 'active')
      .map(t => {
        const remainingMs = Math.max(0, t.gameTargetTime - gameNowMs);
        return { ...t, remainingMs, remainingFormatted: this._formatDuration(remainingMs) };
      })
      .sort((a, b) => a.gameTargetTime - b.gameTargetTime);

    const completedTimers = allTimers
      .filter(t => t.status === 'completed')
      .slice(-20);

    const cancelledTimers = allTimers
      .filter(t => t.status === 'cancelled')
      .slice(-20);

    return { activeTimers, completedTimers, cancelledTimers, isGM: game.user.isGM, shipSystems: this._getSystemsData() };
  }

  /**
   * Set up the Timers view event handlers.
   */
  _setupTimersView(contentEl) {
    if (!game.user.isGM) return;

    // Toggle system rows visibility based on action type
    const actionTypeSelect = contentEl.querySelector('#wy-timer-action-type');
    const systemRow = contentEl.querySelector('#wy-timer-system-row');
    const systemStateRow = contentEl.querySelector('#wy-timer-system-state-row');
    if (actionTypeSelect && systemRow && systemStateRow) {
      actionTypeSelect.addEventListener('change', () => {
        const show = actionTypeSelect.value === 'set-system-state';
        systemRow.style.display = show ? '' : 'none';
        systemStateRow.style.display = show ? '' : 'none';
      });
    }

    // Also show system rows when CATEGORY is 'system'
    const categorySelect = contentEl.querySelector('#wy-timer-category');
    if (categorySelect) {
      categorySelect.addEventListener('change', () => {
        if (categorySelect.value === 'system' && actionTypeSelect) {
          actionTypeSelect.value = 'set-system-state';
          actionTypeSelect.dispatchEvent(new Event('change'));
        }
      });
    }

    // CREATE timer
    contentEl.querySelector('[data-action="create-timer"]')?.addEventListener('click', async () => {
      const label = contentEl.querySelector('#wy-timer-label')?.value?.trim();
      const durationStr = contentEl.querySelector('#wy-timer-duration')?.value?.trim();
      const category = contentEl.querySelector('#wy-timer-category')?.value || 'custom';
      const actionType = contentEl.querySelector('#wy-timer-action-type')?.value || 'log-only';

      if (!label) { ui.notifications.warn('WY-Terminal: Timer label is required.'); return; }
      if (!durationStr) { ui.notifications.warn('WY-Terminal: Timer duration is required.'); return; }

      const durationMs = this._parseEtaDuration(durationStr);
      if (durationMs <= 0) { ui.notifications.warn('WY-Terminal: Could not parse duration. Use formats like "2h 30m", "3 days", "14 weeks".'); return; }

      const actions = [];
      actions.push({
        type: 'add-log',
        sender: 'TIMER SYSTEM',
        subject: `${label.toUpperCase()} COMPLETE`,
        detail: `EVENT TIMER "${label.toUpperCase()}" HAS COMPLETED (${this._formatDuration(durationMs)} ELAPSED).`,
        level: 'INFO',
      });

      if (actionType === 'set-system-state') {
        const systemName = contentEl.querySelector('#wy-timer-system-name')?.value?.trim();
        const systemState = contentEl.querySelector('#wy-timer-system-state')?.value || 'ONLINE';
        if (!systemName) { ui.notifications.warn('WY-Terminal: System name is required for system status actions.'); return; }
        actions.push({
          type: 'set-system-status',
          systemName: systemName.toUpperCase(),
          status: systemState,
          detail: `${systemName.toUpperCase()} STATE CHANGED TO ${systemState} VIA EVENT TIMER.`,
        });
      }

      await this._createEventTimer({ label: label.toUpperCase(), category, durationMs, actions });
      ui.notifications.info(`WY-Terminal: Event timer "${label.toUpperCase()}" created (${this._formatDuration(durationMs)} game time).`);
      this.render(true);
    });

    // CANCEL timer
    contentEl.querySelectorAll('[data-action="cancel-timer"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const timerId = btn.dataset.timerId;
        await this._cancelEventTimer(timerId);
        ui.notifications.info('WY-Terminal: Timer cancelled.');
        this.render(true);
      });
    });

    // DELETE timer (remove from array entirely)
    contentEl.querySelectorAll('[data-action="delete-timer"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const timerId = btn.dataset.timerId;
        await this._deleteEventTimer(timerId);
        ui.notifications.info('WY-Terminal: Timer deleted.');
        this.render(true);
      });
    });

    // EDIT timer — toggle inline edit form visibility
    contentEl.querySelectorAll('[data-action="edit-timer"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const timerId = btn.dataset.timerId;
        const row = contentEl.querySelector(`.wy-timer-row[data-timer-id="${timerId}"]`);
        if (!row) return;
        const editDiv = row.querySelector('.wy-timer-edit');
        const displayDiv = row.querySelector('.wy-timer-display');
        if (editDiv && displayDiv) {
          const isVisible = editDiv.style.display !== 'none';
          editDiv.style.display = isVisible ? 'none' : '';
        }
      });
    });

    // SAVE EDIT — persist changes to timer
    contentEl.querySelectorAll('[data-action="save-timer-edit"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const timerId = btn.dataset.timerId;
        const row = contentEl.querySelector(`.wy-timer-row[data-timer-id="${timerId}"]`);
        if (!row) return;

        const newLabel = row.querySelector('[data-edit-field="label"]')?.value?.trim();
        const newDuration = row.querySelector('[data-edit-field="duration"]')?.value?.trim();
        const newCategory = row.querySelector('[data-edit-field="category"]')?.value;

        const updates = {};
        if (newLabel) updates.label = newLabel.toUpperCase();
        if (newCategory) updates.category = newCategory;

        // If a new duration is specified, recalculate gameTargetTime from now
        if (newDuration) {
          const durationMs = this._parseEtaDuration(newDuration);
          if (durationMs <= 0) {
            ui.notifications.warn('WY-Terminal: Could not parse new duration.');
            return;
          }
          const { date: gameNow } = this._getGameClockDate();
          updates.gameTargetTime = gameNow.getTime() + durationMs;
        }

        await this._updateEventTimer(timerId, updates);
        ui.notifications.info('WY-Terminal: Timer updated.');
        this.render(true);
      });
    });

    // DISCARD EDIT — hide edit form
    contentEl.querySelectorAll('[data-action="cancel-edit"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const timerId = btn.dataset.timerId;
        const row = contentEl.querySelector(`.wy-timer-row[data-timer-id="${timerId}"]`);
        if (!row) return;
        const editDiv = row.querySelector('.wy-timer-edit');
        if (editDiv) editDiv.style.display = 'none';
      });
    });

    // PURGE completed
    contentEl.querySelector('[data-action="purge-completed"]')?.addEventListener('click', async () => {
      await this._purgeTimersByStatus('completed');
      ui.notifications.info('WY-Terminal: Completed timers cleared.');
      this.render(true);
    });

    // PURGE cancelled
    contentEl.querySelector('[data-action="purge-cancelled"]')?.addEventListener('click', async () => {
      await this._purgeTimersByStatus('cancelled');
      ui.notifications.info('WY-Terminal: Cancelled timers cleared.');
      this.render(true);
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     EVENT TIMER ENGINE — Game-clock-aware timers with auto-actions
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Start the GM-only event timer tick loop.
   * Checks every 10 real seconds (= ~100 game-minutes at 10× speed).
   * Player clients just display countdown data — they don't need to fire actions.
   */
  _startEventTimerTick() {
    if (this._eventTimerInterval) return; // Already running
    // Only the GM processes completions. Everybody can read timer state.
    if (!game.user.isGM) return;

    this._eventTimerInterval = setInterval(() => this._tickEventTimers(), 10_000);
    // Fire once immediately on startup to catch any timers that expired while offline
    setTimeout(() => this._tickEventTimers(), 2000);
    // Ensure the default ETA timer exists (creates with 1hr if missing)
    setTimeout(() => this._ensureDefaultEtaTimer(), 3000);
  }

  _stopEventTimerTick() {
    if (this._eventTimerInterval) {
      clearInterval(this._eventTimerInterval);
      this._eventTimerInterval = null;
    }
  }

  /**
   * Ensure the permanent default NAV ETA timer exists.
   * If missing (first boot or after reset), creates it with a 1-hour countdown.
   * If it exists but was completed/cancelled, resets it to active with 1-hour.
   * Called once on GM startup.
   */
  async _ensureDefaultEtaTimer() {
    if (!game.user.isGM) return;
    try {
      const timers = game.settings.get('wy-terminal', 'eventTimers') || [];
      const existing = timers.find(t => t.id === DEFAULT_NAV_ETA_ID);
      if (existing && existing.status === 'active') return; // Already running

      if (existing) {
        // Timer exists but completed/cancelled — reset it to active with 1hr
        const { date: gameNow } = this._getGameClockDate();
        existing.status = 'active';
        existing.gameTargetTime = gameNow.getTime() + DEFAULT_NAV_ETA_MS;
        existing.label = 'NAV ETA';
        existing.category = 'nav';
        existing.actions = this._buildDefaultEtaActions();
        delete existing.completedAt;
        delete existing.cancelledAt;
        await game.settings.set('wy-terminal', 'eventTimers', timers);
      } else {
        // Create fresh default timer
        await this._createDefaultEtaTimer();
      }
      console.log('WY-Terminal | Default NAV ETA timer ensured (1hr)');
      this._broadcastSocket('refreshView', { view: 'nav' });
    } catch (e) {
      console.warn('WY-Terminal | _ensureDefaultEtaTimer failed:', e);
    }
  }

  /**
   * Create the permanent default NAV ETA timer with 1-hour duration.
   */
  async _createDefaultEtaTimer() {
    const timers = this._loadSetting('eventTimers') || [];
    // Remove any stale default timer entry
    const filtered = timers.filter(t => t.id !== DEFAULT_NAV_ETA_ID);
    const { date: gameNow } = this._getGameClockDate();
    filtered.push({
      id: DEFAULT_NAV_ETA_ID,
      label: 'NAV ETA',
      category: 'nav',
      gameTargetTime: gameNow.getTime() + DEFAULT_NAV_ETA_MS,
      createdAt: this._getGameDate(),
      actions: this._buildDefaultEtaActions(),
      status: 'active',
      permanent: true,
    });
    await game.settings.set('wy-terminal', 'eventTimers', filtered);
    return filtered.find(t => t.id === DEFAULT_NAV_ETA_ID);
  }

  /**
   * Build the default action set for the NAV ETA timer.
   */
  _buildDefaultEtaActions(dest) {
    const d = dest || 'DESTINATION';
    return [
      { type: 'set-nav-field', field: 'speed', value: 'FULL STOP' },
      { type: 'set-nav-field', field: 'eta', value: 'ARRIVED' },
      { type: 'add-log', sender: 'NAV COMPUTER', subject: `ARRIVED AT ${d}`, detail: `VESSEL HAS REACHED DESTINATION: ${d}. SPEED SET TO FULL STOP.`, level: 'INFO' },
    ];
  }

  /**
   * Reset all timers to defaults — clears everything and recreates the default ETA timer.
   */
  async _resetTimersToDefault() {
    await game.settings.set('wy-terminal', 'eventTimers', []);
    await this._createDefaultEtaTimer();
    this._broadcastSocket('refreshView', { view: 'all' });
  }

  /**
   * Check all active timers against current game clock.
   * When a timer's target time has passed, execute its actions and mark it completed.
   */
  async _tickEventTimers() {
    let timers;
    try { timers = game.settings.get('wy-terminal', 'eventTimers') || []; }
    catch { return; }

    const active = timers.filter(t => t.status === 'active');
    if (active.length === 0) return;

    const { date: gameNow } = this._getGameClockDate();
    const gameNowMs = gameNow.getTime();
    let changed = false;

    for (const timer of active) {
      if (gameNowMs >= timer.gameTargetTime) {
        // Timer has fired
        console.log(`WY-Terminal | Event timer completed: ${timer.label}`);
        timer.status = 'completed';
        timer.completedAt = this._getGameDate();
        changed = true;

        // Execute each action attached to this timer
        await this._executeTimerActions(timer);
      }
    }

    if (changed) {
      await game.settings.set('wy-terminal', 'eventTimers', timers);
      // Broadcast so all clients see the updated state
      this._broadcastSocket('refreshView', { view: 'all' });
    }
  }

  /**
   * Execute the actions attached to a completed timer.
   * Action types:
   *   - set-nav-field: { field, value } — sets a nav data field
   *   - add-log: { sender, subject, detail, level, classification } — adds a log entry
   *   - set-system-status: { systemName, status, detail } — updates a ship system
   */
  async _executeTimerActions(timer) {
    if (!timer.actions || timer.actions.length === 0) return;

    for (const action of timer.actions) {
      try {
        switch (action.type) {
          case 'set-nav-field': {
            const navData = this._loadSetting('navData') || {};
            navData[action.field] = action.value;
            await game.settings.set('wy-terminal', 'navData', navData);
            break;
          }
          case 'add-log': {
            await this._addLog(
              action.sender || 'MU/TH/UR',
              action.subject || timer.label,
              action.level || 'INFO',
              action.detail || '',
              'text', '', '',
              action.classification || ''
            );
            this._broadcastSocket('refreshView', { view: 'logs' });
            break;
          }
          case 'set-system-status': {
            // Use _getSystemsData() to get actual systems (including defaults from ship profile)
            let systems = this._getSystemsData();
            const sys = systems.find(s => s.name?.toUpperCase() === action.systemName?.toUpperCase());
            if (sys) {
              if (action.status) sys.status = action.status;
              if (action.detail !== undefined) sys.detail = action.detail;
              await game.settings.set('wy-terminal', 'shipSystems', systems);
              this._broadcastSocket('refreshView', { view: 'systems' });
              console.log(`WY-Terminal | System "${action.systemName}" set to ${action.status}`);
            } else {
              console.warn(`WY-Terminal | Timer action: system "${action.systemName}" not found in ship systems.`);
            }
            break;
          }
          default:
            console.warn(`WY-Terminal | Unknown timer action type: ${action.type}`);
        }
      } catch (e) {
        console.error(`WY-Terminal | Timer action failed:`, action, e);
      }
    }
  }

  /**
   * Parse a human-readable ETA string into game-clock milliseconds.
   * Supports formats like: "2h", "30m", "1h 30m", "14 WEEKS", "3 DAYS", "45 MINUTES", "2 HOURS"
   * Returns 0 if unparseable or if it looks like a status (ARRIVED, N/A, etc.).
   */
  _parseEtaDuration(etaStr) {
    if (!etaStr) return 0;
    const s = etaStr.trim().toUpperCase();
    // Skip status-like values
    if (['ARRIVED', 'N/A', 'FULL STOP', 'UNKNOWN', '-', '', 'NOW'].includes(s)) return 0;

    // Skip values that look like _formatDuration output (live countdown text with 3+ segments)
    // e.g. "2W 0D 00H 00M", "5D 02H 30M", "0D 01H 00M"
    // These have at least 3 unit-segments (D+H+M or W+D+H+M). User-typed durations are simpler.
    if (/^\d+[WD]\s+\d+[DHM]\s+\d+[HM]/i.test(s)) return 0;

    let totalMinutes = 0;

    // Match patterns: "14 WEEKS", "14W", "3 DAYS", "3D", "2 HOURS", "2H", "30 MINUTES", "30M"
    const patterns = [
      { re: /(\d+(?:\.\d+)?)\s*W(?:EEKS?)?\b/i, mult: 7 * 24 * 60 },
      { re: /(\d+(?:\.\d+)?)\s*D(?:AYS?)?\b/i,  mult: 24 * 60 },
      { re: /(\d+(?:\.\d+)?)\s*H(?:(?:OU)?RS?)?\b/i, mult: 60 },
      { re: /(\d+(?:\.\d+)?)\s*M(?:IN(?:UTE)?S?)?\b/i, mult: 1 },
    ];

    for (const { re, mult } of patterns) {
      const m = s.match(re);
      if (m) totalMinutes += parseFloat(m[1]) * mult;
    }

    // Also try compact form: "1h30m", "2w3d", "2h", "30m"
    if (totalMinutes === 0) {
      const compact = s.match(/^(?:(\d+)W)?\s*(?:(\d+)D)?\s*(?:(\d+)H)?\s*(?:(\d+)M)?$/i);
      if (compact && (compact[1] || compact[2] || compact[3] || compact[4])) {
        totalMinutes += (parseInt(compact[1]) || 0) * 7 * 24 * 60;
        totalMinutes += (parseInt(compact[2]) || 0) * 24 * 60;
        totalMinutes += (parseInt(compact[3]) || 0) * 60;
        totalMinutes += (parseInt(compact[4]) || 0);
      }
    }

    return totalMinutes * 60 * 1000; // Return game-clock milliseconds
  }

  /**
   * Create an event timer and persist it.
   * @param {object} opts
   * @param {string} opts.label — Display name (e.g. "ARRIVAL AT SUTTER'S WORLD")
   * @param {string} opts.category — 'nav' | 'system' | 'custom'
   * @param {number} opts.durationMs — Duration in game-clock ms from now
   * @param {Array}  opts.actions — Array of action objects to execute on completion
   * @returns {object} The created timer
   */
  async _createEventTimer({ label, category = 'custom', durationMs, actions = [] }) {
    const timers = this._loadSetting('eventTimers') || [];
    const { date: gameNow } = this._getGameClockDate();
    const timer = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: label.toUpperCase(),
      category,
      gameTargetTime: gameNow.getTime() + durationMs,
      createdAt: this._getGameDate(),
      actions,
      status: 'active',
    };
    timers.push(timer);
    await game.settings.set('wy-terminal', 'eventTimers', timers);
    console.log(`WY-Terminal | Event timer created: ${timer.label} (${Math.round(durationMs / 60000)}m game time)`);
    return timer;
  }

  /**
   * Cancel an active event timer by ID.
   * Permanent timers (like the default NAV ETA) cannot be cancelled.
   */
  async _cancelEventTimer(timerId) {
    const timers = this._loadSetting('eventTimers') || [];
    const timer = timers.find(t => t.id === timerId);
    if (timer?.permanent) return false; // Cannot cancel permanent timers
    if (timer && timer.status === 'active') {
      timer.status = 'cancelled';
      timer.cancelledAt = this._getGameDate();
      await game.settings.set('wy-terminal', 'eventTimers', timers);
      this._broadcastSocket('refreshView', { view: 'nav' });
      return true;
    }
    return false;
  }

  /**
   * Get all active timers with remaining time computed.
   * Returns array of { ...timer, remainingMs, remainingFormatted }.
   */
  _getActiveTimers() {
    let timers;
    try { timers = game.settings.get('wy-terminal', 'eventTimers') || []; }
    catch { return []; }

    const { date: gameNow } = this._getGameClockDate();
    const gameNowMs = gameNow.getTime();

    return timers
      .filter(t => t.status === 'active')
      .map(t => {
        const remainingMs = Math.max(0, t.gameTargetTime - gameNowMs);
        return { ...t, remainingMs, remainingFormatted: this._formatDuration(remainingMs) };
      })
      .sort((a, b) => a.gameTargetTime - b.gameTargetTime);
  }

  /**
   * Get all timers (active + completed + cancelled) for display.
   */
  _getAllTimers() {
    try { return game.settings.get('wy-terminal', 'eventTimers') || []; }
    catch { return []; }
  }

  /**
   * Format a game-clock ms duration into a human-readable countdown string.
   * Always shows down to minutes for visible ticking.
   * e.g. 7200000 → "2H 00M", 86400000 → "1D 00H 00M", 604800000 → "1W 0D 00H 00M"
   */
  _formatDuration(ms) {
    if (ms <= 0) return 'ARRIVED';
    const totalMin = Math.floor(ms / 60000);
    const weeks = Math.floor(totalMin / (7 * 24 * 60));
    const days = Math.floor((totalMin % (7 * 24 * 60)) / (24 * 60));
    const hours = Math.floor((totalMin % (24 * 60)) / 60);
    const mins = totalMin % 60;
    const parts = [];
    if (weeks > 0) parts.push(`${weeks}W`);
    if (days > 0 || weeks > 0) parts.push(`${days}D`);
    const hasHigher = days > 0 || weeks > 0;
    if (hours > 0 || hasHigher) parts.push(`${hasHigher ? String(hours).padStart(2, '0') : hours}H`);
    parts.push(`${(hours > 0 || hasHigher) ? String(mins).padStart(2, '0') : mins}M`);
    return parts.join(' ');
  }

  /**
   * Clear all completed/cancelled timers from persistence.
   */
  async _purgeCompletedTimers() {
    const timers = this._loadSetting('eventTimers') || [];
    const active = timers.filter(t => t.status === 'active');
    await game.settings.set('wy-terminal', 'eventTimers', active);
  }

  /**
   * Delete a timer entirely (remove from array regardless of status).
   * Permanent timers cannot be deleted.
   */
  async _deleteEventTimer(timerId) {
    const timers = this._loadSetting('eventTimers') || [];
    const target = timers.find(t => t.id === timerId);
    if (target?.permanent) return; // Cannot delete permanent timers
    const filtered = timers.filter(t => t.id !== timerId);
    await game.settings.set('wy-terminal', 'eventTimers', filtered);
    this._broadcastSocket('refreshView', { view: 'all' });
  }

  /**
   * Update fields on an existing timer by ID.
   * @param {string} timerId
   * @param {object} updates — Partial timer fields to merge (label, category, gameTargetTime, etc.)
   */
  async _updateEventTimer(timerId, updates) {
    const timers = this._loadSetting('eventTimers') || [];
    const timer = timers.find(t => t.id === timerId);
    if (!timer) return false;
    Object.assign(timer, updates);
    await game.settings.set('wy-terminal', 'eventTimers', timers);
    this._broadcastSocket('refreshView', { view: 'all' });
    return true;
  }

  /**
   * Purge all timers with a specific status ('completed' or 'cancelled').
   */
  async _purgeTimersByStatus(status) {
    const timers = this._loadSetting('eventTimers') || [];
    const remaining = timers.filter(t => t.status !== status);
    await game.settings.set('wy-terminal', 'eventTimers', remaining);
  }

  /* ══════════════════════════════════════════════════════════════════
     HELPERS
     ══════════════════════════════════════════════════════════════════ */

  /**
   * Normalize a CRT setting value for backward compatibility.
   * Legacy Boolean true → 'medium', false → 'off'. Strings pass through.
   */
  _normalizeCrtSetting(val) {
    if (val === true) return 'medium';
    if (val === false) return 'off';
    return val || 'medium';
  }

  /**
   * Get the MU/TH/UR header name from the engine.
   */
  _getMuthurHeader() {
    if (this.muthurBridge?.engine) {
      return this.muthurBridge.engine.getHeaderName();
    }
    return 'MU/TH/UR 6000 SERIES';
  }

  /**
   * Return the current in-game date/time as "YYYY-MM-DD HH:MM".
   * Uses the Game Clock setting with 10:1 acceleration
   * (10 game-minutes per 1 real-world minute).
   */
  _getGameDate() {
    return this._getGameClockDate().formatted;
  }

  /**
   * Compute the current game clock Date object + formatted strings.
   * Clock auto-advances at 10× real time from anchor.
   */
  _getGameClockDate() {
    try {
      let epoch = game.settings.get('wy-terminal', 'gameClockEpoch');
      let anchor = game.settings.get('wy-terminal', 'gameClockRealAnchor');
      const paused = game.settings.get('wy-terminal', 'gameClockPaused') ?? false;
      if (!epoch) epoch = Date.UTC(2183, 5, 12, 6, 0, 0);
      if (!anchor) anchor = Date.now();

      // Elapsed real-world ms since anchor, ×10 for game time
      // When paused, no new elapsed time accumulates (epoch holds frozen game time)
      const realElapsed = paused ? 0 : Math.max(0, Date.now() - anchor);
      const gameElapsed = realElapsed * 10;

      const d = new Date(epoch + gameElapsed);
      const pad = (n) => String(n).padStart(2, '0');
      const formatted = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const dateStr = `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`;
      const timeStr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      return { date: d, formatted, dateStr, timeStr };
    } catch (e) {
      return { date: new Date(Date.UTC(2183, 5, 12, 6, 0, 0)), formatted: '2183-06-12 06:00', dateStr: '06/12/2183', timeStr: '06:00' };
    }
  }

  /**
   * Get data for the game clock template.
   */
  _getGameClockDisplayData() {
    const { dateStr, timeStr } = this._getGameClockDate();
    const clockPaused = game.settings.get('wy-terminal', 'gameClockPaused') ?? false;
    return { clockDate: dateStr, clockTime: timeStr, isGM: game.user.isGM, clockPaused };
  }

  _getDisplayTitle() {
    const titles = {
      boot: 'SYSTEM BOOT',
      status: 'SHIP STATUS',
      crew: 'CREW MANIFEST',
      systems: 'SYSTEMS DIAGNOSTIC',
      logs: 'SHIP LOG',
      muthur: 'MU/TH/UR INTERFACE',
      scenes: 'SHIP SCHEMATICS',
      starsystems: 'STELLAR CARTOGRAPHY',
      emergency: 'EMERGENCY PROTOCOLS',
      nav: 'NAVIGATION',
      comms: 'COMMUNICATIONS',
      cargo: 'CARGO MANIFEST',
      weapons: 'WEAPONS SYSTEMS',
      science: 'SCIENCE POD',
      settings: 'CONFIGURATION',
      commandcode: 'COMMAND CODE AUTHORIZATION',
      gameclock: 'GAME CLOCK',
      timers: 'EVENT TIMERS',
    };
    return titles[this.activeView] || 'TERMINAL';
  }

  /* ── Audio Waveform Player ── */

  /**
   * Build a fully themed audio waveform player in the given container.
   * Uses Web Audio API to decode the file and draw a waveform on a <canvas>.
   * Playback position is shown as a moving highlight over the waveform.
   * @param {HTMLElement} container — Parent element to inject the player into
   * @param {string} url — Path to the MP3/WAV file (relative or absolute)
   */
  _buildAudioWaveformPlayer(container, url) {
    // Wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'wy-audio-player';

    // Status label
    const statusLabel = document.createElement('div');
    statusLabel.className = 'wy-audio-status';
    statusLabel.textContent = 'DECODING AUDIO SIGNAL...';
    wrapper.appendChild(statusLabel);

    // Canvas for waveform
    const canvas = document.createElement('canvas');
    canvas.className = 'wy-audio-canvas';
    canvas.width = 600;
    canvas.height = 120;
    wrapper.appendChild(canvas);

    // Time display
    const timeDisplay = document.createElement('div');
    timeDisplay.className = 'wy-audio-time';
    timeDisplay.textContent = '00:00 / 00:00';
    wrapper.appendChild(timeDisplay);

    // Controls row
    const controls = document.createElement('div');
    controls.className = 'wy-audio-controls';

    const playBtn = document.createElement('button');
    playBtn.className = 'wy-scene-btn wy-audio-btn';
    playBtn.textContent = '▶ PLAY';
    controls.appendChild(playBtn);

    const stopBtn = document.createElement('button');
    stopBtn.className = 'wy-scene-btn wy-audio-btn';
    stopBtn.textContent = '■ STOP';
    controls.appendChild(stopBtn);

    wrapper.appendChild(controls);
    container.appendChild(wrapper);

    const ctx = canvas.getContext('2d');
    let audioBuffer = null;
    let audioSource = null;
    let audioCtx = null;
    let isPlaying = false;
    let startTime = 0;
    let pausedAt = 0;
    let animFrame = null;
    let waveformData = null;

    // Decode audio and draw static waveform
    const resolvedUrl = url.startsWith('http') ? url : `${window.location.origin}/${url}`;
    fetch(resolvedUrl)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(buf => {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        return audioCtx.decodeAudioData(buf);
      })
      .then(decoded => {
        audioBuffer = decoded;
        waveformData = this._extractWaveformData(audioBuffer, canvas.width);
        this._drawWaveform(ctx, canvas, waveformData, 0);
        statusLabel.textContent = `AUDIO SIGNAL LOADED — ${this._fmtAudioTime(audioBuffer.duration)}`;
        timeDisplay.textContent = `00:00 / ${this._fmtAudioTime(audioBuffer.duration)}`;
      })
      .catch(err => {
        console.error('WY-Terminal | Audio decode failed:', err);
        statusLabel.textContent = 'ERROR: UNABLE TO DECODE AUDIO SIGNAL';
        statusLabel.style.color = 'var(--wy-red, #ff4444)';
      });

    // Play handler
    playBtn.addEventListener('click', () => {
      if (!audioBuffer || !audioCtx) return;
      if (isPlaying) {
        // Pause
        pausedAt = audioCtx.currentTime - startTime;
        audioSource?.stop();
        isPlaying = false;
        playBtn.textContent = '▶ PLAY';
        if (animFrame) cancelAnimationFrame(animFrame);
        return;
      }

      // Resume / start
      audioSource = audioCtx.createBufferSource();
      audioSource.buffer = audioBuffer;
      audioSource.connect(audioCtx.destination);
      audioSource.onended = () => {
        if (isPlaying) {
          isPlaying = false;
          pausedAt = 0;
          playBtn.textContent = '▶ PLAY';
          if (animFrame) cancelAnimationFrame(animFrame);
          this._drawWaveform(ctx, canvas, waveformData, 0);
          timeDisplay.textContent = `00:00 / ${this._fmtAudioTime(audioBuffer.duration)}`;
          statusLabel.textContent = 'PLAYBACK COMPLETE';
        }
      };

      startTime = audioCtx.currentTime - pausedAt;
      audioSource.start(0, pausedAt);
      isPlaying = true;
      playBtn.textContent = '❚❚ PAUSE';
      statusLabel.textContent = 'PLAYING AUDIO SIGNAL...';

      // Animate waveform position
      const animate = () => {
        if (!isPlaying) return;
        const elapsed = audioCtx.currentTime - startTime;
        const progress = Math.min(elapsed / audioBuffer.duration, 1);
        this._drawWaveform(ctx, canvas, waveformData, progress);
        timeDisplay.textContent = `${this._fmtAudioTime(elapsed)} / ${this._fmtAudioTime(audioBuffer.duration)}`;
        animFrame = requestAnimationFrame(animate);
      };
      animate();
    });

    // Stop handler
    stopBtn.addEventListener('click', () => {
      if (audioSource && isPlaying) {
        audioSource.stop();
      }
      isPlaying = false;
      pausedAt = 0;
      playBtn.textContent = '▶ PLAY';
      if (animFrame) cancelAnimationFrame(animFrame);
      if (waveformData) {
        this._drawWaveform(ctx, canvas, waveformData, 0);
      }
      if (audioBuffer) {
        timeDisplay.textContent = `00:00 / ${this._fmtAudioTime(audioBuffer.duration)}`;
        statusLabel.textContent = `AUDIO SIGNAL LOADED — ${this._fmtAudioTime(audioBuffer.duration)}`;
      }
    });

    // Seek by clicking on canvas
    canvas.addEventListener('click', (e) => {
      if (!audioBuffer) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const seekRatio = x / rect.width;
      const seekTime = seekRatio * audioBuffer.duration;

      if (isPlaying && audioSource) {
        audioSource.stop();
        audioSource = audioCtx.createBufferSource();
        audioSource.buffer = audioBuffer;
        audioSource.connect(audioCtx.destination);
        audioSource.onended = () => {
          if (isPlaying) {
            isPlaying = false;
            pausedAt = 0;
            playBtn.textContent = '▶ PLAY';
            if (animFrame) cancelAnimationFrame(animFrame);
            this._drawWaveform(ctx, canvas, waveformData, 0);
            timeDisplay.textContent = `00:00 / ${this._fmtAudioTime(audioBuffer.duration)}`;
            statusLabel.textContent = 'PLAYBACK COMPLETE';
          }
        };
        startTime = audioCtx.currentTime - seekTime;
        audioSource.start(0, seekTime);
      } else {
        pausedAt = seekTime;
        this._drawWaveform(ctx, canvas, waveformData, seekRatio);
        timeDisplay.textContent = `${this._fmtAudioTime(seekTime)} / ${this._fmtAudioTime(audioBuffer.duration)}`;
      }
    });

    // Store cleanup ref so switching views stops playback
    this._activeAudioCleanup = () => {
      if (isPlaying && audioSource) {
        try { audioSource.stop(); } catch { /* */ }
      }
      if (animFrame) cancelAnimationFrame(animFrame);
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
    };
  }

  /**
   * Extract downsampled waveform peak data from an AudioBuffer.
   * Returns an array of normalized peak values (0..1) — one per canvas pixel.
   */
  _extractWaveformData(audioBuffer, width) {
    const rawData = audioBuffer.getChannelData(0); // mono or left channel
    const samples = rawData.length;
    const blockSize = Math.floor(samples / width);
    const peaks = [];
    for (let i = 0; i < width; i++) {
      let max = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize; j++) {
        const abs = Math.abs(rawData[start + j] || 0);
        if (abs > max) max = abs;
      }
      peaks.push(max);
    }
    return peaks;
  }

  /**
   * Draw the waveform on a canvas with a playback progress highlight.
   * Played portion is bright green, remaining is dim green.
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLCanvasElement} canvas
   * @param {number[]} peaks — Normalized peak array
   * @param {number} progress — 0..1 playback position
   */
  _drawWaveform(ctx, canvas, peaks, progress) {
    if (!peaks) return;
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    const progressX = Math.floor(progress * w);

    ctx.clearRect(0, 0, w, h);

    // Draw center line
    ctx.strokeStyle = 'rgba(127, 255, 0, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // Draw waveform bars
    for (let i = 0; i < peaks.length; i++) {
      const barH = peaks[i] * mid * 0.9;
      if (i < progressX) {
        // Played — bright green with glow
        ctx.fillStyle = 'rgba(127, 255, 0, 0.9)';
        ctx.shadowColor = 'rgba(127, 255, 0, 0.5)';
        ctx.shadowBlur = 3;
      } else {
        // Unplayed — dim green
        ctx.fillStyle = 'rgba(127, 255, 0, 0.3)';
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
      ctx.fillRect(i, mid - barH, 1, barH * 2);
    }

    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // Draw playhead line
    if (progress > 0 && progress < 1) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(progressX, 0);
      ctx.lineTo(progressX, h);
      ctx.stroke();
    }

    // Scanline grid overlay
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
    ctx.lineWidth = 1;
    for (let y = 0; y < h; y += 3) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }

  /**
   * Format seconds into MM:SS display string.
   */
  _fmtAudioTime(secs) {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _loadSetting(key) {
    try {
      return game.settings.get('wy-terminal', key) || [];
    } catch {
      return [];
    }
  }

  async _addLog(sender, subject, level = '', detail = '', mediaType = 'text', mediaUrl = '', timestamp = '', classification = '') {
    const logs = this._loadSetting('logEntries');
    const id = `rt-${Date.now()}`;
    logs.unshift({
      id,
      timestamp: timestamp || this._getGameDate(),
      sender: sender.toUpperCase(),
      subject: subject.toUpperCase(),
      level,
      detail: detail || subject.toUpperCase(),
      mediaType: mediaType || 'text',
      mediaUrl: mediaUrl || '',
      classification: (classification || '').toUpperCase(),
    });
    // Keep last 200 entries
    if (logs.length > 200) logs.length = 200;
    await game.settings.set('wy-terminal', 'logEntries', logs);
  }

  _broadcastSocket(type, payload) {
    game.socket.emit('module.wy-terminal', { type, payload });
  }
}
