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

## Current limitation

Do not connect a production account yet using the upstream in-chat `finish_login` flow. The current upstream implementation stores `client_secret` and refresh credentials in a local JSON file and expects the secret to pass through the AI client. A follow-up hardening change will replace this with secure local credential storage and a local-only setup flow.
