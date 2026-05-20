/**
 * Module Settings Registration
 */

export function registerSettings() {
  // Active ship profile — GM switches between ships
  game.settings.register('wy-terminal', 'activeShip', {
    name: 'WY_TERMINAL.settings.activeShip.name',
    hint: 'WY_TERMINAL.settings.activeShip.hint',
    scope: 'world',
    config: false,  // Managed from in-terminal CONFIG
    type: String,
    default: 'montero',
  });

  game.settings.register('wy-terminal', 'shipName', {
    name: 'WY_TERMINAL.settings.shipName.name',
    hint: 'WY_TERMINAL.settings.shipName.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'USCSS MONTERO',
  });

  game.settings.register('wy-terminal', 'shipClass', {
    name: 'WY_TERMINAL.settings.shipClass.name',
    hint: 'WY_TERMINAL.settings.shipClass.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'M-CLASS STARFREIGHTER',
  });

  game.settings.register('wy-terminal', 'shipRegistry', {
    name: 'WY_TERMINAL.settings.shipRegistry.name',
    hint: 'WY_TERMINAL.settings.shipRegistry.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'REG# 220-8170421',
  });

  game.settings.register('wy-terminal', 'missionName', {
    name: 'WY_TERMINAL.settings.missionName.name',
    hint: 'WY_TERMINAL.settings.missionName.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'CHARIOTS OF THE GODS',
  });

  game.settings.register('wy-terminal', 'muthurUrl', {
    name: 'WY_TERMINAL.settings.muthurUrl.name',
    hint: 'WY_TERMINAL.settings.muthurUrl.hint',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });

  game.settings.register('wy-terminal', 'statusPath', {
    name: 'WY_TERMINAL.settings.statusPath.name',
    hint: 'WY_TERMINAL.settings.statusPath.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'modules/wy-terminal/status',
  });

  game.settings.register('wy-terminal', 'scanlines', {
    name: 'WY_TERMINAL.settings.scanlines.name',
    hint: 'WY_TERMINAL.settings.scanlines.hint',
    scope: 'world',
    config: false,
    type: String,
    default: 'medium',
  });

  game.settings.register('wy-terminal', 'crtFlicker', {
    name: 'WY_TERMINAL.settings.crtFlicker.name',
    hint: 'WY_TERMINAL.settings.crtFlicker.hint',
    scope: 'world',
    config: false,
    type: String,
    default: 'medium',
  });

  game.settings.register('wy-terminal', 'soundEnabled', {
    name: 'WY_TERMINAL.settings.soundEnabled.name',
    hint: 'WY_TERMINAL.settings.soundEnabled.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register('wy-terminal', 'terminalWidth', {
    name: 'WY_TERMINAL.settings.terminalWidth.name',
    hint: 'WY_TERMINAL.settings.terminalWidth.hint',
    scope: 'client',
    config: true,
    type: Number,
    default: 1200,
  });

  game.settings.register('wy-terminal', 'terminalHeight', {
    name: 'WY_TERMINAL.settings.terminalHeight.name',
    hint: 'WY_TERMINAL.settings.terminalHeight.hint',
    scope: 'client',
    config: true,
    type: Number,
    default: 800,
  });

  // Internal: persisted ship status data
  game.settings.register('wy-terminal', 'shipStatusData', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });

  // Internal: GM star systems overrides (added/edited/deleted entries)
  game.settings.register('wy-terminal', 'starSystemsData', {
    scope: 'world',
    config: false,
    type: Object,
    default: { added: [], modified: {}, deleted: [] },
  });

  // Internal: ship maps configuration
  game.settings.register('wy-terminal', 'maps', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: log entries
  game.settings.register('wy-terminal', 'logEntries', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: crew roster
  game.settings.register('wy-terminal', 'crewRoster', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: ship systems
  game.settings.register('wy-terminal', 'shipSystems', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: cargo manifest
  game.settings.register('wy-terminal', 'cargoManifest', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: comm frequency (###.## format, no MHz suffix)
  game.settings.register('wy-terminal', 'commFrequency', {
    scope: 'world',
    config: false,
    type: String,
    default: '475.12',
  });

  // Internal: game clock epoch (ms since JS epoch for the in-game date/time)
  // Default: 2183-06-12 06:00 UTC
  game.settings.register('wy-terminal', 'gameClockEpoch', {
    scope: 'world',
    config: false,
    type: Number,
    default: Date.UTC(2183, 5, 12, 6, 0, 0),
  });

  // Internal: real-world anchor timestamp (Date.now() when epoch was last set)
  game.settings.register('wy-terminal', 'gameClockRealAnchor', {
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });

  // Internal: whether the game clock is paused (GM toggle)
  // Defaults to true so the clock starts STOPPED — GM must hit START CLOCK.
  game.settings.register('wy-terminal', 'gameClockPaused', {
    scope: 'world',
    config: false,
    type: Boolean,
    default: true,
  });

  /* ════════════════════════════════════════════════════════════════
     MU/TH/UR ENGINE SETTINGS
     ════════════════════════════════════════════════════════════════ */

  game.settings.register('wy-terminal', 'openaiBaseUrl', {
    name: 'WY_TERMINAL.settings.openaiBaseUrl.name',
    hint: 'WY_TERMINAL.settings.openaiBaseUrl.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'https://api.openai.com/v1',
  });

  game.settings.register('wy-terminal', 'openaiApiKey', {
    name: 'WY_TERMINAL.settings.openaiApiKey.name',
    hint: 'WY_TERMINAL.settings.openaiApiKey.hint',
    scope: 'world',
    config: true,
    type: String,
    default: '',
  });

  game.settings.register('wy-terminal', 'openaiModel', {
    name: 'WY_TERMINAL.settings.openaiModel.name',
    hint: 'WY_TERMINAL.settings.openaiModel.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'gpt-4o-mini',
  });

  game.settings.register('wy-terminal', 'muthurPlugin', {
    name: 'WY_TERMINAL.settings.muthurPlugin.name',
    hint: 'WY_TERMINAL.settings.muthurPlugin.hint',
    scope: 'world',
    config: true,
    type: String,
    default: 'cronus',
    choices: {
      montero: 'WY_TERMINAL.settings.muthurPlugin.choices.montero',
      cronus: 'WY_TERMINAL.settings.muthurPlugin.choices.cronus',
      cronus_life_support: 'WY_TERMINAL.settings.muthurPlugin.choices.cronusLifeSupport',
      fort_nebraska: 'WY_TERMINAL.settings.muthurPlugin.choices.fortNebraska',
    },
  });

  // Internal: persisted MU/TH/UR engine conversation
  game.settings.register('wy-terminal', 'muthurConversation', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: navigation data (GM-managed)
  // { heading, speed, fuel, eta, position, destination, shipPos, routePoints }
  game.settings.register('wy-terminal', 'navData', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });

  // Internal: active clearance level (legacy single-value, kept for migration)
  // Values: CREWMEMBER | NONE | MEDICAL | CAPTAIN | CORPORATE | MASTER_OVERRIDE
  game.settings.register('wy-terminal', 'activeClearanceLevel', {
    scope: 'world',
    config: false,
    type: String,
    default: 'CREWMEMBER',
  });

  // Internal: per-user clearance levels — { [userId]: 'CORPORATE', ... }
  // Each connected user has their own independent clearance level.
  game.settings.register('wy-terminal', 'userClearanceLevels', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });

  // Internal: command codes for crew access (legacy array, kept for migration)
  // Each entry: { name: 'MILLER', role: 'CAPTAIN', code: '1234' }
  game.settings.register('wy-terminal', 'commandCodes', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: per-user command codes — { [userId]: { code: '12345678', role: 'CAPTAIN' }, ... }
  // Each user has a unique 8-digit command code with an associated clearance role.
  // Valid roles: CREWMEMBER, MEDICAL, CAPTAIN, CORPORATE, MASTER_OVERRIDE
  game.settings.register('wy-terminal', 'userCommandCodes', {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });

  // Internal: which Actor folders to show in the CREW view.
  // Stored as an array of Folder IDs. Empty = show ALL character/synthetic actors.
  game.settings.register('wy-terminal', 'crewFolders', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: which ships are enabled for the Player-Terminal schematic selector
  // Stored as an array of profile ids, e.g. ['montero']. Empty = ALL ships visible.
  game.settings.register('wy-terminal', 'enabledShips', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

  // Internal: event timers tracked against game clock
  // Each entry: { id, label, category, gameTargetTime, createdAt, actions, status }
  game.settings.register('wy-terminal', 'eventTimers', {
    scope: 'world',
    config: false,
    type: Array,
    default: [],
  });

}
