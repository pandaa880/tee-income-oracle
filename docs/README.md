# docs

Technical documentation for this repo — architecture, trust boundaries, and
build specifics. Pitch, business, and planning material live outside this
public repo, deliberately.

- `FORMATS.md` — every wire/data format (keys, KeyMaterial, JWS, ReBIT messages, policy, 83-byte payload, signed message, enclave API, test-vector layout). Source of truth for both Rust and TS.
- `CODING-GUIDELINES.md` — engineering principles, security rules, Rust/Anchor/TypeScript/Python conventions, tests, git.
- `ARCHITECTURE.md` — how the system works and why it's secure: trust zones, components, key inventory, end-to-end flow, threat model.
- `DEPLOY.md` — how the demo runs on devnet: programs, the enclave on Marlin Oyster, gateway + sandbox bank on Azure Container Apps, restart procedure, costs.

Root `LICENSE`, `NOTICE`, and `CONTRIBUTING.md` cover licensing and
contribution process — see the repo root, not this folder.
