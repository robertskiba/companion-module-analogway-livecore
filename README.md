# companion-module-analogway-livecore  
With this module you can control all graphic switchers from the Livecore series by Analog Way.

See HELP.md and LICENSE

## Version History

### 3.0.0 (2026-08-22)
* major: require Companion v4.3+ (upgraded to @companion-module/base v2)
* fix: PGM/PVW memory feedback finally works after all those years
* fix: config save no longer crashes the connection
* fix: several old bugs where ass-kicked
* feature: screen, memory, master memory, confidence memory, monitoring memory and input options are now dynamic, named dropdowns instead of free-text numbers
* feature: global take selection gained a toggle option and a single-screen action
* feature: connected device is auto-detected and shown in the config instead of a manual picker
* feature: new variables for per-screen t-bar/name/memory/global-take/resolution/confidence status, per-output name/active/HDCP, and device health
* change: connects on port 10500 instead of a user-selectable port due to getting valid feedbacks

### 2.0.0 (2023-06-11)
* major: rewrite for Companion v3 compatibility
* feature: add feedbacks for source tally, memory tally and screen selection
* feature: add variables parsing for custom command
