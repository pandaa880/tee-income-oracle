# Changelog

## [0.4.0](https://github.com/pandaa880/tee-income-oracle/compare/v0.3.0...v0.4.0) (2026-10-10)


### Features

* **gateway,ops:** sponsor loan transactions and add a second demo pool ([#34](https://github.com/pandaa880/tee-income-oracle/issues/34)) ([8f94594](https://github.com/pandaa880/tee-income-oracle/commit/8f945942a0aa1e3e99176c9feb200e1d017ebab3))
* **ui:** add the @tio/ui package (tokens, primitives, patterns) ([#36](https://github.com/pandaa880/tee-income-oracle/issues/36)) ([4ba94ed](https://github.com/pandaa880/tee-income-oracle/commit/4ba94edb76141c5b33b764adf5a5616fd259e59a))
* **web:** add the borrow-flow logic layer (gateway stream, relay, chain checks) ([#38](https://github.com/pandaa880/tee-income-oracle/issues/38)) ([2df24c2](https://github.com/pandaa880/tee-income-oracle/commit/2df24c26c5088e3fc3920762ad3384464825ad60))
* **web:** scaffold the Vite app on @tio/ui with Vercel config ([#37](https://github.com/pandaa880/tee-income-oracle/issues/37)) ([86390cc](https://github.com/pandaa880/tee-income-oracle/commit/86390cc3130fbb73552a3df5b11ed8452dd00945))

## [0.3.0](https://github.com/pandaa880/tee-income-oracle/compare/v0.2.0...v0.3.0) (2026-10-08)


### Features

* **demo-pool:** add attestation-gated lending pool ([#24](https://github.com/pandaa880/tee-income-oracle/issues/24)) ([5628f23](https://github.com/pandaa880/tee-income-oracle/commit/5628f2357f1df791ac307b38bb90bab9356bb319))
* deploy to devnet with the enclave on Oyster and a gateway-only bank token ([#32](https://github.com/pandaa880/tee-income-oracle/issues/32)) ([19001b2](https://github.com/pandaa880/tee-income-oracle/commit/19001b24806272ded7af2fac4e83ba49a0f0f2ac))
* **enclave:** add enclave HTTP server around tio-core ([#25](https://github.com/pandaa880/tee-income-oracle/issues/25)) ([2407c88](https://github.com/pandaa880/tee-income-oracle/commit/2407c887d375a9a3d64fc7c74bb1fb3e13b106af))
* **gateway:** add session orchestrator and attestation relayer ([#28](https://github.com/pandaa880/tee-income-oracle/issues/28)) ([ac37998](https://github.com/pandaa880/tee-income-oracle/commit/ac37998eb2c2d129e9437e4b8cda0ea66e5d6038))
* **ops:** add oracle init, demo pool, enclave rotation and devnet e2e scripts ([#30](https://github.com/pandaa880/tee-income-oracle/issues/30)) ([5fe2324](https://github.com/pandaa880/tee-income-oracle/commit/5fe2324a6016b2ea0dd34455a860d30bf1819dd7))
* **ops:** add SAS credential and schema setup script ([#20](https://github.com/pandaa880/tee-income-oracle/issues/20)) ([c57de0f](https://github.com/pandaa880/tee-income-oracle/commit/c57de0f54e231ed2ecfa11fdfa421e43f515f910))
* **oracle:** add enclave registry ([#22](https://github.com/pandaa880/tee-income-oracle/issues/22)) ([d69d478](https://github.com/pandaa880/tee-income-oracle/commit/d69d47850447ea2661c8d53916857b0e81b2b4eb))
* **oracle:** add submit_attestation with secp256k1 precompile check and SAS write ([#23](https://github.com/pandaa880/tee-income-oracle/issues/23)) ([2f98baf](https://github.com/pandaa880/tee-income-oracle/commit/2f98baf6f5525df48fea8748239aa8ca5fec57b8))
* **sandbox-bank:** add live mock FIP + AA HTTP service ([#27](https://github.com/pandaa880/tee-income-oracle/issues/27)) ([8364adc](https://github.com/pandaa880/tee-income-oracle/commit/8364adc00d9fbe539a5de2e3b51a128da8199901))


### Bug Fixes

* **gateway:** re-check the registry entry per submit, enforce erasable syntax ([#29](https://github.com/pandaa880/tee-income-oracle/issues/29)) ([7db501f](https://github.com/pandaa880/tee-income-oracle/commit/7db501f766cb7c27450312ffa592482e99071ae7))

## [0.2.0](https://github.com/pandaa880/tee-income-oracle/compare/v0.1.0...v0.2.0) (2026-10-04)


### ⚠ BREAKING CHANGES

* policy v1 is rejected; the default policy_hash changed, so consumers must re-pin it.

### Features

* add scoring policy v2 ([#15](https://github.com/pandaa880/tee-income-oracle/issues/15)) ([9e5deb0](https://github.com/pandaa880/tee-income-oracle/commit/9e5deb05f840227101466498b01192e146fe92e5))
* **tio-core:** add classification, features and tiering ([#17](https://github.com/pandaa880/tee-income-oracle/issues/17)) ([63b496b](https://github.com/pandaa880/tee-income-oracle/commit/63b496b1e73ab6ae9fca30c9ad3eea7fcd02f125))
* **tio-core:** add evaluate pipeline and attestation payload ([#18](https://github.com/pandaa880/tee-income-oracle/issues/18)) ([b534a2f](https://github.com/pandaa880/tee-income-oracle/commit/b534a2fe7510ed4ee28adecf32a1117c3604b12e))
* **tio-core:** add paise money parser ([#12](https://github.com/pandaa880/tee-income-oracle/issues/12)) ([7d432c5](https://github.com/pandaa880/tee-income-oracle/commit/7d432c55d42a95038a54f543054e9e5a970a084b))
* **tio-core:** parse DEPOSIT FI data ([#14](https://github.com/pandaa880/tee-income-oracle/issues/14)) ([c580f92](https://github.com/pandaa880/tee-income-oracle/commit/c580f92d6aa44bcf17e968cf06211a5dc2aaf9d4))


### Bug Fixes

* **tio-core:** reject policies with unreachable tiers ([#16](https://github.com/pandaa880/tee-income-oracle/issues/16)) ([7f5b6f1](https://github.com/pandaa880/tee-income-oracle/commit/7f5b6f13305f18b9338ef40579549fccb3da590d))

## 0.1.0 (2026-09-29)


### Features

* **sandbox-bank:** add test-vector generator with Rust cross-check ([#9](https://github.com/pandaa880/tee-income-oracle/issues/9)) ([8a9c178](https://github.com/pandaa880/tee-income-oracle/commit/8a9c178db40d81ee512f15279d683662104096b1))
* **tio-core:** add Curve25519 key exchange and AES-GCM decryption ([#6](https://github.com/pandaa880/tee-income-oracle/issues/6)) ([2f98a14](https://github.com/pandaa880/tee-income-oracle/commit/2f98a14cbc6fd86db687af6478541aced64aaab4))
* **tio-core:** add RS256/RS512 JWS verify and FIU signing ([#8](https://github.com/pandaa880/tee-income-oracle/issues/8)) ([29cc16f](https://github.com/pandaa880/tee-income-oracle/commit/29cc16f3c79e099c53f57280010ab8924e884558))
