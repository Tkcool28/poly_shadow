# POLY-SHADOW — Upstream Pin

| Field | Value |
|---|---|
| Upstream repository | https://github.com/mantotan/polymarket-copy-trade |
| Upstream author | Hermanto Tan (@mantotan) |
| License | MIT (see `LICENSE`, preserved unchanged) |
| Pinned commit (fork `main`) | `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` |
| Pin verified | 2026-10-05, upstream `main` HEAD == fork `main` HEAD == pinned SHA |
| Fork | https://github.com/Tkcool28/polymarket-copy-trade (server-side fork, full history) |
| Working name | **Poly-Shadow** (repo rename pending; see note below) |

## Why a server-side fork

GitHub does not support forking into a pre-existing, differently-named empty
repository (`Tkcool28/poly_shadow` was created empty and cannot receive a fork).
A server-side fork preserves full history, the exact pinned tree, and MIT
attribution with zero content copying. To converge on the intended name:

1. Delete the empty `Tkcool28/poly_shadow` repository (it contains nothing).
2. Rename this fork: Settings → General → Repository name → `poly-shadow`.

Until then, all shadow work happens in this fork.

## Policy: upstream sync

Upstream updates are **never merged automatically**. Any future upstream
change is reviewed individually against the shadow's V2 requirements before
cherry-picking. Per the Hermes feasibility audit
(`POLY2_ONCHAIN_SOURCE_FEASIBILITY_V1`), upstream's watcher and decoder target
legacy V1 contracts and must not be adopted unchanged — see
`PHASE1_ASSESSMENT.md` §5.
