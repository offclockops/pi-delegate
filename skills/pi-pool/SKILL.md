---
description: Join a pi-intercom pool of pi sessions; the pool name is optional
disable-model-invocation: true
---

Join this Claude session to a pi-intercom pool. Pool name argument: `$ARGUMENTS`.

1. Call `pi_intercom` with `action: "pool"`. Pass `name` only when the argument is not empty.
2. Report the pool name and the `join` line, which the user runs in each pi window.
3. List the members with full ID, name, model, status, and idle seconds.
4. A member with model `claude-code` is another coordinator. A member marked `child` belongs to
   another session's delegation.
5. If `pi_intercom` is missing or has no `pool` action, say that this needs the pi-delegate
   plugin at 0.16.0 or later with `intercom` configured.
