# Changelog

All notable changes to this project are documented here.

## [0.1.1] - 2026-11-14

### Fixed

- Restore the right-slot teammate model picker on DSH 0.2.2-rc.3. rc3 removed
  `useAnchoredPosition` from the client primitives; the adapted selector now
  measures its trigger and menu locally when that hook is unavailable.
- Keep the seat in `conversation.input.right`; the official
  `conversation.input.model` picker and main-session behavior are unchanged.

### Tests

- 13 tests passing, including the anchoring fallback and right-slot
  registration regression checks.

## [0.1.0] - 2026-11-08

### Added

- Host API for validating and applying a model route to an addressed
  subagent/teammate session.
- Per-session durable preference, replayed when a dormant teammate activates.
- Right-slot UI using the official `ModelSelect` catalog and styling.
