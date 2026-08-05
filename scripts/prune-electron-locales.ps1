param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$ApplicationDirectory
)

$resolvedApplication = (Resolve-Path -LiteralPath $ApplicationDirectory -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($resolvedApplication) -ne 'Siren-Records-Music-Downloader-win32-x64') {
    throw "Refusing to prune locales outside the expected packaged application directory: $resolvedApplication"
}

$localeDirectory = Join-Path $resolvedApplication 'locales'
if (-not (Test-Path -LiteralPath $localeDirectory -PathType Container)) {
    Write-Output 'No Electron locales directory found; nothing to prune.'
    exit 0
}

$keep = @('en-US.pak', 'zh-CN.pak')
$removed = Get-ChildItem -LiteralPath $localeDirectory -File |
    Where-Object { $keep -notcontains $_.Name }
foreach ($file in $removed) {
    Remove-Item -LiteralPath $file.FullName -Force
}

Write-Output ("Removed {0} unused Electron locale files; kept {1}." -f $removed.Count, ($keep -join ', '))
