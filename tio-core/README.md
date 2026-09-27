# tio-core

The code inside the sealed box.

## What this is, in plain English

A borrower wants a loan, and the lender wants proof of steady income. The
borrower's bank can send their statement, but the borrower doesn't want
anyone, including us, reading their full transaction history.

So the project builds a **sealed box**. The bank statement goes in, and only a
grade (A, B, C or Reject) comes out. Nobody can look inside, and anyone can
check that the box ran this published code.

`tio-core` is the code inside that box. It is the only part of the project
that ever touches secret keys or the real bank data. Everything else (the
website, the server, the blockchain) only moves sealed envelopes around.

It is small and boring on purpose. It has no internet access, no files, no
clock and no randomness of its own: the enclave hands those in. That keeps it
easy to audit, and easy to test against fixed examples.

### The private mailbox (key exchange and decryption)

The bank has to send the statement *through* our server, and we treat our own
server as untrusted. So the bank must lock the statement in a way only the
box can unlock.

- For each loan application, the box makes a fresh **padlock and key**. It
  hands out the open padlock and keeps the key inside. The key never leaves.
- The bank does the same. Each side combines its own key with the other's
  padlock, and both arrive at the same **shared secret** without it ever being
  sent. Someone watching the traffic sees the padlocks but can't work out the
  secret.
- Both sides also add a random number, so every session's lock is different.
- The bank seals the statement with that secret. The seal is also a
  **tamper-evident sticker**: if anyone changes even one byte on the way, the
  box notices and refuses it.
- Indian bank software writes these padlocks in an older, unusual format. It
  is the same math in different coordinates, like one address written in two
  coordinate systems. `tio-core` translates between them so that a
  well-tested library does the secret multiplication, instead of crypto we
  wrote ourselves.
- It is proven against real examples captured from India's official
  reference software: our code has to reproduce them byte for byte.

### The signature checker (planned, build step 1b)

The bank and the Account Aggregator each **sign** what they send, like a wax
seal. The box will check that each seal comes from a signer it already knows
(their public keys are built into the box, so the server can't swap in fake
ones), that only approved signature types are used, and that the seal is
checked *before* the contents are read. The box also signs its own request
to the bank, so the server can't slip in its own padlock and read the
statement.

### The practice exams (planned, build step 1c)

A separate generator, written in TypeScript, produces fake statements for
three made-up borrowers, their sealed envelopes, and deliberately broken
copies (one byte changed, wrong signer, missing seal). The box must accept
the good ones and reject each broken one *for the right reason*. Two
independent implementations have to agree, so they catch each other's
mistakes.

### Why it is built this way

- **Small and boring.** It is the one part everyone must trust.
- **No secrets leave the box.** The server carries sealed data it can neither
  open nor forge.
- **Tested against real-world examples**, not only against itself.

## Technical summary

| Module | Does |
|---|---|
| `ecdh` | Per-session Curve25519 key pair; parse and validate a peer key (`wei25519` BouncyCastle SPKI or RFC 7748 `x25519`); shared secret |
| `cipher` | 32-byte nonces; `HKDF-SHA256(shared, salt = xn[0..20])`, `iv = xn[20..32]`; AES-256-GCM decrypt |
| `key_material` | ReBIT `KeyMaterial` JSON: build ours, read a peer's |
| `time` | Unix seconds to ReBIT ISO-8601 UTC |
| `encoding` | PEM and base64 helpers |

Rules it follows: `#![forbid(unsafe_code)]`, secrets in `Zeroizing`, no
panics in library code (enforced by clippy), stable error codes via the
`ErrorCode` trait.

```bash
cargo test -p tio-core
```

- Formats: [`docs/FORMATS.md`](../docs/FORMATS.md) §3
- Security model: [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- Reference vectors: [`test-vectors/golden/rahasya/`](../test-vectors/golden/rahasya/)
