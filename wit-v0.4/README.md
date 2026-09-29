# WIT 0.4

`wasm-plugin-host:plugin@0.4.0` keeps WIT 0.3 typed UI and adds a typed hook decision surface.

New type:

```wit
variant hook-decision {
  continue,
  rewrite(json),
  veto(string),
}
```

New lifecycle export:

```wit
invoke-hook: func(op: string, args-json: json) -> hook-decision;
```

This removes the Component-only JSON envelope `{kind: continue|rewrite|veto}` from hook replies.
The rewrite payload remains JSON because flow-event payloads are intentionally polymorphic.

Older 0.1/0.2/0.3 Components remain supported and continue to use the legacy raw-JSON hook reply path.
