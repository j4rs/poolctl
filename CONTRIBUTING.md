# Contributing

**This repository is not accepting pull requests yet.** Outside PRs are
closed automatically — that is not a judgement on the change, it is that the
design is still moving and no equipment has been on the bus yet. Merging
someone else's work into a system whose central numbers are still unmeasured
would be unfair to them.

Issues, though, are open and genuinely wanted:

- **Corrections to the record.** Much of this repo is claims about how
  [nodejs-poolController](https://github.com/tagyoureit/nodejs-poolController)
  behaves, arrived at by reading its source. Four design decisions were
  reversed once someone actually read it properly. If a claim here is wrong,
  saying so is the most useful thing you can do.
- **njsPC integration reports.** Especially anything about Nixie mode, the
  shared-body model, schedules, or pump circuit binding.
- **Pentair RS-485 decoding**, particularly whether an iChlor 30 emits the
  case-18 salt message. That one is an open question blocking a decision.

## What this is

A DIY pool/spa controller for **one specific site**, published because the
reasoning may be useful to someone building their own — not as a product.
Valve travels, relay wiring, and flow thresholds here are not transferable.
Survey your own system.

Read [the safety notice](README.md#-safety) before anything else. The 240 V
side is work for a licensed electrician.

## If you are forking it

Please do. Two things to carry with you:

- The supervisor is **MIT** and njsPC is **AGPL-3.0**. They are deliberately
  separate processes. Merging them changes the licence of everything.
- The heater's own thermostat owns its setpoint and its hard caps. Moving
  thermostat logic into software is how a pool controller scalds someone.
  See ADR-4 in [the PRD](docs/prds/poolctl-v1.md).
