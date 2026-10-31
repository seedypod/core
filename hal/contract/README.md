# HAL contract v1

The wire contract between `hald` (Rust) and core (TypeScript). Both sides carry
their own typed copy — `hal/crates/hal-core/src/contract.rs` and
`src/hardware/contract.ts` — and `hal/contract/fixtures/*.json` are the
golden samples both test suites must parse identically. Change the contract by
adding a fixture first, then making both sides accept it. See ADR-0007.
