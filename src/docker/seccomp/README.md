# Seccomp profiles

`browser-sandbox.json` is passed inline to Docker (`SecurityOpt: ["seccomp=<json>"]`) for containers created with
the `browser-sandbox` runtime security profile. JSON cannot carry comments, so its provenance is recorded here.

- Base: Docker 29.1.3 `vendor/github.com/moby/profiles/seccomp/default.json`.
- Added: `clone` and `unshare`, allowed only when the flags argument avoids NEWNS, NEWCGROUP, NEWUTS and NEWIPC
  (mask `0x0E020000`), so only user, pid and net namespaces can be created; `setns`; `chroot` (Chromium's zygote
  needs it).
- Changed: the `socket` rule is rewritten as per-family allows, so `AF_NETLINK` with `NETLINK_NETFILTER` and
  `AF_VSOCK` are denied.
- Both of these were tested and do not work, which is why the rules look the way they do: a conditional ERRNO
  rule does not override the base profile's allow, and two comparisons on one argument in a single rule misbehave.

The file is imported with `resolveJsonModule`, so `tsc` copies it into `dist/docker/seccomp/`.
