#!/usr/bin/env node
// systemctl for the simulated bring-up: the restore helper's service commands
// (stop/start seedypod-core and hald) go to the harness, which owns those
// processes, and wait until it has done them.
const r = await fetch(process.env.SIM_CONTROL_URL, { method: 'POST', body: JSON.stringify(process.argv.slice(2)) }).catch(() => null)
process.exit(r?.ok ? 0 : 1)
