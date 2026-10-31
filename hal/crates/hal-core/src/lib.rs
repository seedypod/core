//! `hal-core` — the hardware-independent heart of `hald`.
//!
//! * [`contract`] — the v1 wire types shared with core (`src/hardware/contract.ts`).
//! * [`device`] — `Sensor` / `Actuator` traits every driver implements.
//! * [`safety`] — the interlocks that make the pump safe to expose to anyone:
//!   bounded runs, dry-run refusal, over-temperature cutoff, latched faults.
//! * [`registry`] — config-driven collection of devices.
//!
//! Nothing here touches GPIO or I²C; those live in driver crates behind the traits,
//! which is what lets the same safety code run against real hardware, the
//! simulator, and unit tests.

pub mod contract;
pub mod device;
pub mod registry;
pub mod safety;

pub use contract::*;
pub use device::{Actuator, DeviceError, Sensor};
pub use safety::{PumpGuard, PumpLimits, Refusal};
