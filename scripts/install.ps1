# Native Windows bootstrap. No profile or PATH changes.
$ErrorActionPreference = 'Stop'
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ai-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$oldHost = $env:GH_HOST
try {
    & node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'
    if ($LASTEXITCODE -ne 0) { throw 'Node >=22.19 required' }
    New-Item -ItemType Directory -Path $tmp | Out-Null
    if ($env:AGENT_RELEASE_DIR) {
        Copy-Item (Join-Path $env:AGENT_RELEASE_DIR 'agent-distribution.mjs') $tmp
        Copy-Item (Join-Path $env:AGENT_RELEASE_DIR 'SHA256SUMS') $tmp
    } else {
        $env:GH_HOST = 'github.com'
        & gh auth status
        if ($LASTEXITCODE -ne 0) { throw 'Authenticated gh with repository access required' }
        $repo = if ($env:AGENT_RELEASE_REPO) { $env:AGENT_RELEASE_REPO } else { 'GabrielMendonca1/agent' }
        if ($repo -notmatch '^[\w.-]+/[\w.-]+$') { throw 'Invalid repository' }
        $download = @('release', 'download', '-R', $repo, '-p', 'agent-distribution.mjs', '-p', 'SHA256SUMS', '-D', $tmp)
        if ($env:AGENT_VERSION) {
            if ($env:AGENT_VERSION -notmatch '^[\w.+-]+$') { throw 'Invalid release tag' }
            $download += $env:AGENT_VERSION
        }
        $view = @('release', 'view', '-R', $repo, '--json', 'tagName', '--jq', '.tagName')
        if ($env:AGENT_VERSION) { $view += $env:AGENT_VERSION }
        $tag = & gh @view
        if ($LASTEXITCODE -ne 0 -or $tag -notmatch '^[\w.+-]+$') { throw 'Cannot resolve release tag' }
        # Pin bootstrap and payload to the same release.
        if ($env:AGENT_VERSION) { $download = $download[0..($download.Length-2)] }
        $download += $tag
        $env:AGENT_VERSION = $tag
        & gh @download
        if ($LASTEXITCODE -ne 0) { throw 'Bootstrap download failed' }
    }
    $bootstrap = Join-Path $tmp 'agent-distribution.mjs'
    $matches = @(Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -cmatch '^([a-f0-9]{64})  agent-distribution\.mjs$' })
    if ($matches.Count -ne 1 -or ((Get-FileHash $bootstrap -Algorithm SHA256).Hash.ToLowerInvariant() -ne $matches[0].Substring(0,64))) { throw 'Bootstrap digest mismatch' }
    & node $bootstrap install @args
    $code = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    $code = 1
} finally {
    $env:GH_HOST = $oldHost
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
}
exit $code
