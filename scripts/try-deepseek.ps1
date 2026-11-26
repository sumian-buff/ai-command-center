$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'try-deepseek.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& node --test (Join-Path $PSScriptRoot '../tests/')
exit $LASTEXITCODE
