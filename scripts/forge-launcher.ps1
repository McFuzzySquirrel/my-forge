#Requires -Version 5.1
# Deprecated compatibility wrapper for forge-launcher; retained for one release.
# The canonical implementation is the Node npm package at scripts/forge-launcher/.
# Keep existing invocations working during the package migration.

$PkgDir = Join-Path $PSScriptRoot "forge-launcher"

function Convert-ForgeArguments {
    param([string[]]$Values)
    foreach ($value in $Values) {
        if ($value -cmatch '^-([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)$' -and $value.Length -gt 2) {
            $option = [regex]::Replace($Matches[1], '([a-z0-9])([A-Z])', '$1-$2').ToLowerInvariant()
            "--$option"
        } else {
            $value
        }
    }
}

$ForwardArgs = @(Convert-ForgeArguments $args)

function Invoke-Forge {
    $distCli = Join-Path $PkgDir "dist\cli.js"
    if (Test-Path $distCli -PathType Leaf) {
        & node $distCli @ForwardArgs
        exit $LASTEXITCODE
    }
    $tsxLocal = Join-Path $PkgDir "node_modules\.bin\tsx"
    $tsxGlobal = Get-Command tsx -ErrorAction SilentlyContinue
    if (Test-Path $tsxLocal) {
        & $tsxLocal (Join-Path $PkgDir "scripts\cli.ts") @ForwardArgs
        exit $LASTEXITCODE
    }
    if ($tsxGlobal) {
        & $tsxGlobal.Source (Join-Path $PkgDir "scripts\cli.ts") @ForwardArgs
        exit $LASTEXITCODE
    }
    Write-Error "forge-launcher: package not built. Run in scripts\forge-launcher\: npm install; npm run build"
    exit 1
}

Invoke-Forge
