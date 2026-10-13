# Security hardening for AI-controlled VK Ads

This fork is intended for connecting a live VK Ads account to an AI assistant. The defaults are deliberately conservative.

## Network boundary

The VK Ads API origin is pinned to `https://ads.vk.com/api`. The runtime does not accept an arbitrary API base URL. This prevents access tokens and OAuth credentials from being redirected to another host through configuration.

External usage telemetry is disabled in this fork.

## Write modes

`VK_ADS_WRITE_MODE` controls mutation capabilities:

- `read-only` (default) — all POST/DELETE operations are blocked before any network request.
- `draft` — allows creation of ad plans, ad groups and banners, but forces `status=blocked`; also allows stopping existing ad plans, ad groups and banners. Other updates, activation and deletion are blocked.
- `full` — allows writes, still subject to configured budget caps.

The policy is enforced centrally by `HardenedVkAdsClient`, so it also applies to `raw_request`.

## Budget caps

Optional hard limits:

- `VK_ADS_MAX_DAILY_BUDGET` — maximum accepted `budget_limit_day`.
- `VK_ADS_MAX_TOTAL_BUDGET` — maximum accepted `budget_limit`.

Requests above a configured cap are rejected before reaching VK Ads.

## Authentication boundary

The upstream in-chat OAuth flow is disabled. `finish_login` accepts no credentials, and `start_login` only explains the temporary local-token setup.

Until a secure local credential store is implemented:

- obtain the VK Ads access token outside the AI conversation;
- provide it only to the local MCP process as `VK_ADS_TOKEN`;
- never send `client_secret`, refresh tokens or access tokens through an AI chat.

Legacy credential-reading code remains internally for compatibility/migration, but the MCP tool surface cannot create a new plaintext stored login.

## Dependency and packaging boundary

`@modelcontextprotocol/sdk` is pinned to a patched v1 release and CI rejects high/critical runtime dependency advisories with `npm audit --omit=dev --audit-level=high`.

Upstream marketplace/plugin manifests were removed because they launched the published upstream npm package and therefore bypassed this fork's hardening. The fork is marked `private` in `package.json` and should be run from a reviewed source commit until dedicated packaging is introduced.
