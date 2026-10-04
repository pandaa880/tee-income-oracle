# Changelog

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
