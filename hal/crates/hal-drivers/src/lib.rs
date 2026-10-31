//! `hal-drivers` — the real Gardyn drivers.
//!
//! Every driver is generic over the small traits in [`bus`] (`I2cBus`,
//! `DigitalOut`, `DigitalIn`, `PwmOut`, `Clock`, `Delay`), so register
//! decoding, CRCs, debouncing and timing math are unit-tested on any host
//! with scripted bytes. The rppal implementations of those traits live in
//! [`hw`] behind the `hardware` cargo feature; default builds and CI never
//! link against GPIO.
//!
//! Pins and addresses are constructor arguments, never constants: `hald`'s
//! `config.rs` / `hal.toml` is the single source of truth (AGENTS.md).

pub mod am2320;
pub mod bus;
pub mod button;
pub mod dht20;
pub mod dosing;
pub mod dyp_a01;
pub mod ezo;
pub mod gpio_binary;
pub mod ina219;
pub mod pct2075;
pub mod pwm;
pub mod uvc;

#[cfg(feature = "hardware")]
pub mod hw;
