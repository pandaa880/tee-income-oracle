# Solana Attestation Service (SAS) program binary

`sas.20261004.so` is the SAS program **as deployed on devnet**, dumped for
offline tests (surfpool now, the oracle's CPI tests later). It is not built
from source: SAS publishes no binaries, and its repo's latest program
release (2.0.0, 2026-09-25) was not yet deployed when this was dumped, so
source and chain differ.

| Field | Value |
|---|---|
| Program id | `22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG` |
| Cluster | devnet |
| Dumped | 2026-10-04, at devnet slot ~507399497 |
| Program last deployed in slot | 385530432 (pre-2.0.0 build) |
| ProgramData address | `HqaxR5hg8yYyuM5QPiWMhSAvXGWwfDBbvthvYpqMQ73v` |
| sha256 | `afacc7215d6ab6759bcf5edb958a1ad1d9de7559d53ac807c6aa4775a1a5a357` |
| Re-checked | 2026-10-08, before the devnet deployment: a fresh dump has the same sha256 |
| License | MIT, SAS's own; full text in `LICENSE` next to this file |

Reproduce and compare:

```sh
solana program dump -ud 22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG /tmp/sas.so
shasum -a 256 /tmp/sas.so
```

A different hash means SAS was upgraded on devnet. Dump it again under a new
dated name, update this file, and rerun the tests. Don't overwrite the old
file in the same change, so the diff shows the switch.
