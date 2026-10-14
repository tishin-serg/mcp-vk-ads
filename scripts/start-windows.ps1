param([ValidateSet('read-only', 'draft', 'full')][string]$Mode = 'read-only')
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$env:VK_ADS_WRITE_MODE = $Mode
$env:VK_ADS_API_BASE = 'https://ads.vk.com/api'
# Use only protected local credentials, not inherited temporary access tokens.
Remove-Item Env:VK_ADS_TOKEN -ErrorAction SilentlyContinue
if ($Mode -ne 'read-only' -and (!$env:VK_ADS_MAX_DAILY_BUDGET -or !$env:VK_ADS_MAX_TOTAL_BUDGET)) {
    throw 'Set approved daily and total budget caps before launching draft/full.'
}
& node (Join-Path $repo 'dist\index.js')
exit $LASTEXITCODE
