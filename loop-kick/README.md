# LOOP-KICK

The approved LOOP-KICK messaging device and its Node/Express message service.

## Run locally

```bash
pnpm install
pnpm server
```

The service listens on `http://localhost:8787` by default and stores messages in
`data/loop-kick.sqlite`. Set `PORT`, `HOST`, or `LOOP_KICK_DB_PATH` to override
those defaults.

The temporary authentication boundary uses `x-loop-user-id` and
`x-loop-peer-id` headers for REST calls, plus `user` and `peer` query parameters
for `/ws`. These identifiers are intentionally isolated so production session
authentication can replace the stub without changing the wire contract.

```bash
pnpm test:server
pnpm dev
```

The live transport uses the existing runtime configuration documented in
`HANDOFF.md`; the React device still defaults to its built-in mock.

## Frontend template notes

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.
