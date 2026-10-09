# Phase C — local-only verification and recovery (2026-10-09)

## GitHub CI policy

The repository's `.github/workflows/ci.yml` **has been deleted entirely** at the user's request. This removes the previous manual `workflow_dispatch` entry as well as automated triggers. The `dsh-wasm-studio` repository has no GitHub Actions workflow configured either. All checks are run on the user's Mac through the connected tunl Runner, using `scripts/verify-openhanako-local.sh` (including the targeted local AutomationPanel Vitest regression), or the equivalent local commands. No GitHub-hosted CI jobs, remote runners or workflow dispatch actions are called.

## Changes

1. **Resilient native scheduler.** Fixed the one-shot due-task bug that previously treated the natural absence of another run as fatal for the entire tick. A malformed cron is quarantined without blocking other jobs; concurrent manual/timed dispatch is locked per job; `lastAttemptAt` and interrupted/failed/success states are durably recorded. The native host can resume a cold pinned Agent from disk after restart. Atomic stage-b saves now sync contents before rename. A crash can still lose one claimed occurrence before dispatch; this is at-most-once delivery, not exactly-once.
2. **Automation status in the UI.** The scheduler's actual `lastError` or last-completed timestamp is rendered on the automation card instead of treating every scheduled attempt as a success. Failed jobs are visible and may be run manually again.
3. **Opt-in legacy project migration.** An authenticated native catalog preview (`GET /api/session-projects/native-migration`) shows source counts, a source signature and current native revision. Import requires an explicit double-confirmation in the right rail and passes both revisions. It refuses to overwrite a non-empty native catalog, drops orphaned assignment links, requires a Studio success ACK and **preserves the original browser localStorage source** so there is no silent data loss. There is no automatic migration on upgrade.
4. **Local test focus.** Rust tests cover due one-shot/invalid schedule isolation, restart-readable state, run locks and error reporting; JS bridge/DOM tests cover migration preview, expired revision, double confirmation, ACK and preservation. Run `cargo check --all-targets`, the two local Cargo test suites, `npm --prefix plugins/openhanako-shell test`, `npm run typecheck` and `npm run build:renderer` locally before committing.

## Remaining deployment acceptance

Start the newly compiled installed Studio desktop binary on macOS, verify actual allowed and blocked sandboxed shell calls, persistent native project data across a GUI restart, and an automation firing while Studio is open. The restricted tunl runner does not allow validating nested `sandbox-exec` success. The project migration deliberately refuses conflicts instead of attempting automatic merges. No background OS service for automations is included.
