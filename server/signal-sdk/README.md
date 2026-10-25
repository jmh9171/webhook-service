Signal server capture SDK copied from `jmh9171/clonalytics`, commit
`c181c6bfa81b2ae954c1737ad8219cbc54608df0`:

- `src/sdk/server.ts` → `sdk/server.ts`
- `src/sdk/capture.ts` → `sdk/capture.ts`
- `src/shared/contracts.ts` → `shared/contracts.ts`

These files retain the upstream import layout and are used only by
`server/signal.ts`. Update them together when adopting a newer Signal collector
contract. Browser capture is intentionally not included.
