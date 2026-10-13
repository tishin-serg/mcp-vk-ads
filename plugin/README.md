# Plugin packaging disabled in this hardened fork

The upstream repository contains marketplace/plugin manifests that launch the published `mcp-vk-ads` npm package. Those manifests are intentionally removed from this fork because they would bypass the hardened source code and run the upstream package instead.

Use the hardened fork only from a reviewed checkout/commit. Do not install `mcp-vk-ads@latest` expecting to receive the security changes from this repository.

Current authentication policy:

- do not pass `client_secret`, refresh tokens or access tokens through an AI chat;
- until secure local credential storage is implemented, supply `VK_ADS_TOKEN` only in the local MCP process environment;
- the default write mode is `read-only`; see `docs/HARDENING.md` for `draft`, `full`, and budget caps.

Marketplace packaging can be reintroduced later only after it launches an artifact built from this fork and preserves the same security boundaries.
