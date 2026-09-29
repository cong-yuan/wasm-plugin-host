# WIT 0.2 draft

This directory is the parallel, version-bumped Component contract for the next
wire revision:

```text
wasm-plugin-host:plugin@0.2.0
```

It deliberately coexists with `../wit`; the host now loads both 0.1 and 0.2 contracts side by side.

## First wire change

`tool-decl` adds:

```wit
requires: list<string>
```

This carries the tool-level dependency graph that the core/internal ABI already
supports through `ToolDecl.requires[]`.

The runtime semantics are unchanged:

- missing dependencies hide only the affected tool;
- hooks, services and unrelated tools remain active;
- provider appearance/disappearance converges tool chains automatically;
- declared names remain reserved while blocked;
- self-dependencies are rejected.

## Compatibility rule

Do **not** edit `../wit/plugin.wit` to add this field. Adding a required record
field changes the Component canonical ABI. Existing 0.1 Components must continue
loading unchanged.

## Current status

The 0.2 contract is compile-validated by `host/tests/wit_contract.rs`, including an explicit generated `ToolDecl.requires` construction. Runtime dispatch detects the versioned lifecycle export (`...@0.1.0` vs `...@0.2.0`) from the compiled Component type, instantiates the matching generated bindings/linker, and converts both versions into the same internal `PluginDecl` / `InvokeResult` model.

## Next steps

1. keep Rust 0.1 + 0.2 smoke tests in CI;
2. add a JS 0.2 producer when the JS demo needs tool dependencies;
3. type additional stable wire surfaces (for example UI declaration) only through explicit 0.2 changes;
4. retain all 0.1 smoke tests so compatibility remains continuously verified.
