<#
.SYNOPSIS
  Prints a small sample of an existing media folder layout, read-only.

.DESCRIPTION
  Used to tune the scanner (phase 2) to existing folder and file names.
  For each library folder (e.g. Movies, Series, Anime) it shows the number of
  subfolders and a few file paths, then a count per file extension.
  Nothing is changed on disk.

    powershell -ExecutionPolicy Bypass -File .\scripts\media-sample.ps1 -Root D:\Media
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$Root,
  [int]$FoldersPerLibrary = 3,
  [int]$FilesPerFolder = 5
)

$Root = (Resolve-Path $Root).Path.TrimEnd('\', '/')

foreach ($library in Get-ChildItem $Root -Directory) {
  $folders = @(Get-ChildItem $library.FullName -Directory)
  "== $($library.Name): $($folders.Count) folders"
  $folders | Select-Object -First $FoldersPerLibrary | ForEach-Object {
    Get-ChildItem $_.FullName -Recurse -File | Select-Object -First $FilesPerFolder |
      ForEach-Object { '  ' + $_.FullName.Substring($Root.Length).TrimStart('\', '/') }
  }
}

''
'== File types'
Get-ChildItem $Root -Recurse -File | Group-Object Extension |
  Sort-Object Count -Descending | Select-Object -First 15 |
  ForEach-Object { '  {0,7}  {1}' -f $_.Count, $_.Name }
