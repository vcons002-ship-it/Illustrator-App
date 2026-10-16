param([string]$InstallRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($InstallRoot)
$exe = Join-Path $root 'apps\desktop\src-tauri\target\release\visual-reader-desktop.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Build the packaged desktop executable first: $exe" }
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Visual Reader - Qwen 2.1.lnk'
$backupDirectory = Join-Path $env:USERPROFILE ('VisualReader\backups\shortcut-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Path $backupDirectory | Out-Null
if (Test-Path -LiteralPath $link) { Copy-Item -LiteralPath $link -Destination $backupDirectory }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $exe
$shortcut.Arguments = ''
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$exe,0"
$shortcut.Description = 'Visual Reader - packaged local app (all image models; existing desktop profile)'
$shortcut.WindowStyle = 1
$shortcut.Save()
Write-Output "Repaired: $link"
Write-Output 'Close all Visual Reader windows, then double-click this exact shortcut in Explorer. Verify chats AND Souls; a running process alone does not prove recovery.'
