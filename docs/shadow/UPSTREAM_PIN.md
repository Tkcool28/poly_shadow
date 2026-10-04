# POLY-SHADOW — Upstream Pin

| Field | Value |
|---|---|
| Upstream repository | https://github.com/mantotan/polymarket-copy-trade |
| Upstream author | Hermanto Tan (@mantotan) |
| License | MIT (see `LICENSE`, preserved unchanged) |
| Pinned commit (fork `main`) | `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` |
| Pin verified | 2026-10-05, upstream `main` HEAD == fork `main` HEAD == pinned SHA |
| Working repository | https://github.com/Tkcool28/poly_shadow (server-side fork of upstream, full history, renamed) |

## Fork provenance

This repository is a server-side GitHub fork of upstream (a fork cannot be
created into a pre-existing differently-named empty repo, so the fork was
created under the upstream name and then renamed to `poly_shadow`). Full
history, the exact pinned tree, and MIT attribution are preserved.

## Policy: upstream sync

Upstream updates are **never merged automatically**. Any future upstream
change is reviewed individually against the shadow's V2 requirements before
cherry-picking. Per the Hermes feasibility audit
(`POLY2_ONCHAIN_SOURCE_FEASIBILITY_V1`), upstream's watcher and decoder target
legacy V1 contracts and must not be adopted unchanged — see
`PHASE1_ASSESSMENT.md` §5.
