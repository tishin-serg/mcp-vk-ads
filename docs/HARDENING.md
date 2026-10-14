# Security hardening for AI-controlled VK Ads

This fork is intended for connecting a live VK Ads account to an AI assistant. The defaults are deliberately conservative.

## Network boundary

The VK Ads API origin is pinned to `https://ads.vk.com/api`. The runtime does not accept an arbitrary API base URL. This prevents access tokens and OAuth credentials from being redirected to another host through configuration.

External usage telemetry is disabled in this fork.

Authenticated REST and OAuth requests refuse HTTP redirects, including 307/308
redirects that would otherwise replay the OAuth secret body. Both the REST client
constructor and OAuth token URL builder validate the official API base directly.

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

The upstream in-chat OAuth flow is disabled. `finish_login` accepts no credentials.

On Windows, persistent credentials are created only by the local interactive command:

```text
npm run auth:setup
```

The command:

1. reads `client_id` and a hidden `client_secret` from the local TTY;
2. mints the token only against the pinned VK Ads API origin;
3. verifies the actual account with `v3/user.json`;
4. rejects a mismatched agency username or user ID before storing the candidate;
5. stores the complete credential payload and typed auth target with Windows DPAPI `CurrentUser`.

Local setup supports own and agency-client targets. Temporary manager tokens used
for `GET v3/manager/clients.json` are never written to disk. No tool accepts a
secret or changes the selected target. The OAuth client uses `agency_client_name`
(login), not a manager cabinet ID. See [OAuth evidence](./OAUTH-CONTRACT.md).

Agency refresh uses the ordinary refresh-token grant. Every refreshed candidate
is checked against the stored username AND verified user ID before use/storage.
A confirmed account mismatch removes invalid agency credentials, guarded against
deleting a newer login. A failed setup preserves any previous verified login;
failed candidates never reach persistent storage. Malformed target metadata is
refused rather than silently treated as own-account authentication.

Provider/fetch auth errors are sanitized: secrets supplied to OAuth are redacted,
and local verification does not return response bodies or request headers.
All new agency tests run in the existing native Windows CI leg, including DPAPI.

The plaintext secret is never passed in argv or environment variables. When Node invokes PowerShell for DPAPI, the plaintext/ciphertext is sent over child-process stdin.

On Windows, legacy plaintext credential files are refused rather than silently accepted. A fresh `npm run auth:setup` is required to create a DPAPI envelope.

`VK_ADS_TOKEN` remains supported as an explicit local environment override for CI and temporary setups. It is never echoed by `auth_status`.

## Storage boundary

The Windows credential file is a JSON envelope containing only:

- format marker `dpapi-v1`;
- scope marker `CurrentUser`;
- DPAPI ciphertext.

`client_secret`, access token and refresh token must not appear as plaintext in the file. CI includes a native Windows round-trip test that encrypts, reads and decrypts credentials under the same Windows account and asserts that the raw file contains none of those secret values.

## Dependency and packaging boundary

`@modelcontextprotocol/sdk` is pinned to a patched v1 release and CI rejects high/critical runtime dependency advisories with `npm audit --omit=dev --audit-level=high`.

Upstream marketplace/plugin manifests were removed because they launched the published upstream npm package and therefore bypassed this fork's hardening. The fork is marked `private` in `package.json` and should be run from a reviewed source commit until dedicated packaging is introduced.

## CI platforms

The main test matrix covers:

- Ubuntu / Node 20;
- Ubuntu / Node 22;
- Ubuntu / Node 24;
- Windows / Node 22.

The Windows leg is mandatory because DPAPI and the local Windows build path cannot be validated on Linux.
