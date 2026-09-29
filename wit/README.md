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

The same rule applies to resource budgets: Component `describe` and `invoke` results are charged against `limits.max_output_bytes` after canonical lifting, while Wasmtime memory/fuel/epoch limits remain the earlier physical execution boundary.

## JSON boundary and WIT versioning

The `0.1.0` world intentionally keeps JSON strings where the payload is genuinely dynamic:

- tool JSON Schema and tool invocation arguments / values;
- service call arguments / results;
- event/hook payloads whose shape depends on the event vocabulary;
- the legacy UI declaration bridge (`ui-json`).

The first three are not accidental transport debt: the host tool/service model is JSON-Schema-driven and event payloads are polymorphic. Converting them to one giant WIT variant would duplicate the host schema system without adding authority or validation.

`ui-json` is different: the UI declaration now has a stable internal schema and is a reasonable candidate for a typed WIT record. However, changing `plugin-decl` in-place would change the canonical ABI of already-built `wasm-plugin-host:plugin@0.1.0` Components. Therefore wire-shape changes such as typed UI declarations or a dedicated typed hook-decision export belong in a new WIT package/world version, while Registry identity, policy and lifecycle semantics remain unchanged.

Compatibility rule for `0.1.0`: do not add/reorder required record fields or required exports in-place. Additive host implementation behavior is fine; guest-visible canonical ABI changes require a WIT version bump.

`../wit-v0.2` is the first parallel version-bumped contract. Its initial wire change is typed `tool-decl.requires: list<string>`, matching the internal `ToolDecl.requires[]` dependency graph. `host/tests/wit_contract.rs` compiles both 0.1 and 0.2 bindings, and the runtime detects the versioned lifecycle export to dispatch the matching Component backend while preserving one internal Registry model.

## Validation

`host/tests/wit_contract.rs` invokes Wasmtime's `component::bindgen!` against both `../wit` (0.1) and `../wit-v0.2` (0.2). Therefore normal `cargo check --all-targets` validates both WIT packages without requiring a separate `wasm-tools` CLI.

## Runtime status

`Runtime::artifact_kind()` distinguishes core modules from Components, `compile_component()` provides an mtime-aware in-process Component cache, and `compile_artifact()` is the stable compile entrypoint for both shapes. `PluginBackend::Core | Component` routes both transports behind the same Registry/Supervisor API. Component lifecycle (`abi-version`, `init`, `configure`, `describe`, `invoke`, `shutdown`) is live, including resource budgets and capability resolution.

## Host import binding status

`host/src/component_backend.rs` now binds the generated WIT host interfaces directly to the existing `HostState`:

- log/config reuse the live host state and log budget;
- network reuses `CapabilityGate::require_http`, redirect policy and resolved-IP filtering;
- filesystem reuses the same grant roots, cap-std handles and mutation implementation;
- services reuse `services.consume` authorization and the existing service graph.

The generated lifecycle exports are wrapped as typed calls and converted back into the existing internal `PluginDecl` / `InvokeResult` model, so hooks, services and UI remain transport-agnostic. `plugins/component-rust-demo` and `plugins/component-js-demo` both run through the normal Registry path. The JS demo additionally validates custom `host-log` / `host-config` imports, sandbox capability request ∩ grant, QuickJS/stub-wasi, and default StarlingMonkey/Preview2.

## Remaining producer / ABI work

- Python/componentize-py producer validation remains blocked on the current runner: even componentize-py's minimal hello-world is terminated by the OS with SIGKILL, across tested versions. This is tracked as an environment validation item rather than a Host runtime blocker.
- WIT `0.2.0` exists in parallel, types tool dependencies, and is runtime-loadable alongside 0.1.
- Later 0.2 additions may type the stable UI declaration and/or introduce a dedicated typed hook-decision surface before 0.2 is treated as stable.
