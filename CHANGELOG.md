# Changelog

## 3.0.0beta1 — Maintenance & Companion v2 update (August 2026)

A maintenance pass on the module. Nothing here changes how you use it day to day — same actions, same buttons — but the module now tracks the switcher's actual state correctly, and stops asking you to type numbers you'd otherwise have to look up.

### Fixed

These were not edge cases — they affected the core feedback loop of running a show.

- **Program/Preview feedback is trustworthy after a Take.** The "which memory is live" feedback used to go stale the moment you took a screen — it kept showing the pre-take state. It now tracks the T-bar position itself, so PGM/PVW feedback stays correct through takes, not just through loads.
- **Confidence screens could get stuck.** Switching a screen into Confidence mode made it vanish from every screen picker, with no way to select it again to switch it back. Confidence screens now stay selectable everywhere it matters.
- **Saving the connection config no longer crashes it.** Changing the IP address and saving used to throw the module into an error state instead of reconnecting.
- **"Source used" feedback works instead of erroring.** This feedback (highlighting a button when its source is on air) was broken at a code level and never actually evaluated.
- **The connection no longer garbles itself under load.** A bug in how the module read data off the wire meant that whenever the switcher sent several status lines back-to-back, everything after the first line could get corrupted and silently dropped — very likely the cause of assorted "it just stops updating" issues.
- Fixed a typo in the port selector (10400 was mislabeled "10500").
- Fixed the master-memory range in the "Memory active" feedback (was capped at 119 instead of 144).

### Added

- **Named, filtered dropdowns everywhere a number used to go.** Screens, regular memories, master memories, confidence memories, monitoring memories, and inputs are now all populated live from the device, labelled with their real names, and limited to what actually exists on your rig.
  - Screens show as e.g. `S2 – Livestream`.
  - Master Memory only lists slots that actually have something saved to them.
  - Inputs show as e.g. `3 – SDI – Playout-Fill` (number, active connector, name), and selecting one also lists which connectors are physically available on it.
- **Global Take selection gained a toggle.** The existing multi-screen selection action now has an "toggle" option alongside add/remove, and there's a new single-screen action for building per-screen toggle buttons.
- **Connected device auto-detection.** The connection settings no longer have a manual "which model" picker — the module now shows what it actually detected (model name, and whether it's talking to the AW_SIMULATOR).
- **New variables:**
  - Per screen: T-bar position (`up`/`down`), name, memory loaded in Program/Preview, global-take-selection status, confidence-screen status, resolution (width × height).
  - Per output: name, active status, HDCP status.
  - Device: firmware version, connected controller count, fan alarm, temperature alarm, ready status.

### Changed

- **Connects on port 10500 instead of 10600**, and the port is no longer user-configurable. Port 10500 is the richer channel the operator panel itself uses; it's what makes live T-bar tracking and the named dropdowns possible. Existing connections pick this up automatically on update.
- **Upgraded `@companion-module/base` from `~1.4.1` to `^2.1.3`** (and `@companion-module/tools` to `^3.0.2`). Requires **Companion 4.3 or newer** — installations on an older Companion release should stay on the previous module version. This also puts the module's fields on Companion's current expression system going forward.

### Internal

- Migrated the module entrypoint from `runEntrypoint()` to a default export + named `UpgradeScripts` export (required by base v2).
- `setVariableDefinitions` now uses the v2 object-keyed format instead of an array.
- Removed `context.parseVariablesInString()` in favour of Companion resolving `useVariables` fields before the action callback runs.
- `companion/manifest.json`: `runtime.type` updated to `node22`; added the now-required top-level `"type": "connection"` field.
