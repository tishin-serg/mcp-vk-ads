# OAuth contract evidence — 2026-10-14

Official entry points attempted:

- https://ads.vk.com/doc/api
- https://ads.vk.com/ru/doc/api/info/Авторизация%20в%20API
- https://ads.vk.com/help/articles/help_api

These did not yield readable official documentation in this environment
(web retrieval errors/HTTP 404; browser navigation was blocked after the site's
redirect). No browser safety bypass was attempted. Therefore this implementation
uses the requested fallback: comparison of independent executable source code,
not a third-party MCP README. Live agency verification remains required before
claiming that the user's account is connected.

## Agency mint

`POST https://ads.vk.com/api/v2/oauth2/token.json`, URL-encoded body:

```text
grant_type=agency_client_credentials
client_id=<manager API application ID>
client_secret=<local hidden input>
agency_client_name=<client username/login>
```

The chosen identifier is the username, including an `@agency_client` suffix when
present. It is not the manager cabinet ID or manager↔client relationship ID.
The typed model intentionally supports this verified login form only. Some
implementations also accept `agency_client_id`; its numeric semantics are not
needed here and are not guessed or added to the public model.

Independent implementations inspected at pinned commits:

1. [nikolaymokh-dev Python client](https://github.com/nikolaymokh-dev/vk-ads-mcp/blob/0e3d83849b3678d78bff4e6d63aff358b82fef85/src/vk_ads_mcp/client.py):
   `_ensure_token` switches the grant and sends `agency_client_name` from the
   configured login to the same VK Ads OAuth endpoint.
2. [nebelov Python auth helper](https://github.com/nebelov/vk-ads-for-all/blob/cee6cb55bedaba86d3647d1e0d2337139a1fd165/plugins/vk-ads-for-all/scripts/vk_ads_auth.py):
   `form_for_args` uses `agency_client_name` for a supplied login; its alternative
   numeric identifier branch is deliberately not used in this fork.
3. [CRAN rmytarget auth source](https://github.com/cran/rmytarget/blob/a02fbcc8bbd80010c8924574cc21d25148e33043/R/myTarAuth.R):
   older myTarget lineage independently implements agency login via
   `agency_client_name`. This is supplementary historical evidence only.

These sources support the request shape; reading their code does not prove they
currently authenticate this specific account.

## Refresh

Ordinary `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`.
No agency identifier is sent. This agrees in:

- the nebelov helper's refresh branch above;
- [alexeitsurkan PHP SDK refreshToken](https://github.com/alexeitsurkan/vk-ads-php-sdk/blob/e438a72ad5d6376ebd5fe58145054eb8d7a41d3a/src/VkAdsOAuth.php);
- [rmytarget refresh source](https://github.com/cran/rmytarget/blob/a02fbcc8bbd80010c8924574cc21d25148e33043/R/myTarRefreshToken.R).

Client binding is expected to travel with the refresh token. It is **not assumed
as a safety guarantee**: the fork preserves the selected target in DPAPI and
checks `v3/user.json` username and verified user ID after each agency refresh.
It never falls back to minting an own/manager token on refresh errors.

## Client discovery

Manager-token GET to `v3/manager/clients.json` is implemented in the
[PHP ManagerService](https://github.com/alexeitsurkan/vk-ads-php-sdk/blob/e438a72ad5d6376ebd5fe58145054eb8d7a41d3a/src/services/manager/ManagerService.php).
Its [selection criteria](https://github.com/alexeitsurkan/vk-ads-php-sdk/blob/e438a72ad5d6376ebd5fe58145054eb8d7a41d3a/src/services/manager/criterias/ManagerClientSelectionCriteria.php)
distinguish `user.id` and `user.username` from relationship-level fields.
Discovery is read-only and paginated. If permission or response shape prevents
discovery, setup asks for a login and still performs the account verification gate.

## Validation

Unit/integration-style tests cover own and agency grants, exact form fields,
temporary manager isolation, discovery/fallback, secret-safe output, DPAPI target
round-trip, wrong-account rejection, and agency refresh binding. They use fake
secrets and run on Windows as well as the existing Linux matrix. Real advertising
mutations are not part of validation. Live setup/smoke results are local operator
evidence, not fabricated by the offline test suite.
