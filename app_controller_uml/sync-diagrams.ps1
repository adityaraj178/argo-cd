# Extracts the mermaid block from each NN-*.md into mmd/, then renders svg/ and png/.
# Usage: .\sync-diagrams.ps1            # all diagrams
#        .\sync-diagrams.ps1 01,04      # only these prefixes
param([string[]]$Only)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$fail = 0

# Normalize -Only. Invoked via `powershell -File`, "02,04" arrives as one string
# with leading zeros stripped, so split on commas and pad back to two digits.
if ($Only) {
    $Only = $Only |
        ForEach-Object { $_ -split '[,;\s]+' } |
        Where-Object { $_ -match '^\d+$' } |
        ForEach-Object { '{0:D2}' -f [int]$_ }
    if (-not $Only) { throw "-Only did not contain any diagram numbers" }
    Write-Host "Filtering to: $($Only -join ', ')" -ForegroundColor Cyan
}

Get-ChildItem -Path $root -Filter '*.md' |
    Where-Object {
        $m = [regex]::Match($_.Name, '^(\d\d)-')
        $m.Success -and (-not $Only -or ($Only -contains $m.Groups[1].Value))
    } |
    ForEach-Object {
        $md   = $_
        $stem = [IO.Path]::GetFileNameWithoutExtension($md.Name)
        $text = Get-Content $md.FullName -Raw

        $m = [regex]::Match($text, '(?s)```mermaid\r?\n(.*?)\r?\n```')
        if (-not $m.Success) {
            Write-Host "SKIP  $stem (no mermaid block)" -ForegroundColor DarkGray
            return
        }

        $body = $m.Groups[1].Value
        $bad  = [regex]::Matches($body, '[^\x00-\x7F]')
        if ($bad.Count -gt 0) {
            Write-Host "WARN  $stem has $($bad.Count) non-ASCII char(s) in the mermaid block" -ForegroundColor Yellow
        }

        $mmd = Join-Path $root "mmd/$stem.mmd"
        [IO.File]::WriteAllText($mmd, $body + "`n", (New-Object Text.UTF8Encoding $false))

        foreach ($fmt in 'svg', 'png') {
            $out = Join-Path $root "$fmt/$stem.$fmt"
            $args = @('-i', $mmd, '-o', $out, '-b', 'white')
            if ($fmt -eq 'png') { $args += @('-s', '2') }
            $log = & mmdc @args 2>&1 | Out-String
            if ($LASTEXITCODE -ne 0 -or $log -match 'Error') {
                Write-Host "FAIL  $stem -> $fmt" -ForegroundColor Red
                Write-Host $log
                $script:fail++
            }
        }
        if ($fail -eq 0) { Write-Host "OK    $stem" -ForegroundColor Green }
    }

if ($fail -gt 0) { Write-Host "`n$fail render failure(s)" -ForegroundColor Red; exit 1 }
Write-Host "`nAll diagrams rendered." -ForegroundColor Green
