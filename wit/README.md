# Component Model / WIT contract

This directory is the Phase E transport contract for future Component Model
plugins. The current production ABI remains the core-module ABI documented in
`docs/ABI.md`; adding this WIT package does not change existing Rust/Go guests.

## World

The selected world is:

```text
wasm-plugin-host:plugin/plugin
```

It imports:

- `host-log`
- `host-config`
- `host-network`
- `host-filesystem`
- `host-services`

and exports `lifecycle`.

## Migration rule

Component Model is a transport replacement, not a second plugin framework.

The following host concepts stay authoritative and shared with the core-module
backend:

```text
PluginPolicy
CapabilitySet
EffectiveCapabilities
CapabilityGate
AuditSink
Registry lifecycle / slot identity
service convergence
hook EventSpec
resource budgets
```

Every generated host implementation must delegate to those existing gates.
For example:

```text
host-network.http-fetch
  -> CapabilityGate.require_http(...)
  -> DNS resolved-IP policy
  -> existing HTTP implementation

host-filesystem.write-file
  -> CapabilityGate.require_filesystem_write(...)
  -> existing cap-std root handle

host-services.call-service
  -> CapabilityGate.require_service_consume(...)
  -> existing service graph
```

A Component guest must not receive broader authority merely because it uses WIT.

## Transitional JSON fields

The first WIT version types lifecycle, capability requests, host operations and
result envelopes, while retaining JSON strings for genuinely dynamic payloads:

- tool JSON Schema
- tool invocation arguments / values
- hook/event payloads when introduced
- UI declaration payload during the first migration step

These can be replaced incrementally by additional WIT records without changing
Registry identity, policy or lifecycle semantics.

## Validation

`host/tests/wit_contract.rs` invokes Wasmtime's `component::bindgen!` against
this directory. Therefore normal `cargo check --all-targets` validates the WIT
package without requiring a separate `wasm-tools` CLI.

## Runtime seam status

`Runtime::artifact_kind()` now distinguishes core modules from Components,
`compile_component()` provides an mtime-aware in-process Component cache, and
`compile_artifact()` is the stable compile entrypoint for both shapes. Existing
core guests still follow the unchanged module path. `Plugin::load` recognizes a
Component and reports that lifecycle execution is not wired yet.

## Next implementation step

Add a Component-backed plugin instance that implements the same internal
operations currently used by `Plugin`:

1. init/configure/describe
2. invoke
3. shutdown
4. host log/config/network/filesystem/service imports

The eventual load branch should replace the current explicit Component-status
error without changing Registry or Supervisor APIs.
