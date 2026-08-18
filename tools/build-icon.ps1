<#
.SYNOPSIS
    Builds the PPTB tool icon (SVG) from the source PNG logo.

.DESCRIPTION
    Power Platform ToolBox requires the manifest `icon` to be an .svg file — @pptb/validate
    rejects any other extension outright. The source logo is a full-colour raster, so it is
    embedded into an SVG wrapper as a base64 data URI rather than vectorised.

    Two things this fixes along the way:

      1. Size. The source is ~1.1 MB at 1254x1254. Tool icons render small, so it is
         downscaled first, which takes the embedded payload down to a few tens of KB.

      2. Background. The source has an opaque near-white background baked in (no alpha
         channel), which would appear as a white box in ToolBox's dark theme. The background
         is flood-filled from the edges and made transparent. Flood fill is used rather than a
         global threshold so that white *inside* the artwork — the magnifier face, the dollar
         sign on the money bag — is preserved.

    Re-run this whenever the source logo changes.

    Windows only: relies on System.Drawing.

.EXAMPLE
    powershell -File tools/build-icon.ps1
#>
[CmdletBinding()]
param(
    [string]$SourcePath,
    [string]$OutputPath,
    [int]$Size = 128,
    # How far a pixel may differ from the sampled corner colour and still count as background.
    [int]$Tolerance = 24
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is not reliably populated in param defaults across hosts, so resolve here.
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Path }
$repo = $root
if ((Split-Path -Leaf $root) -eq 'tools') { $repo = Split-Path -Parent $root }

if (-not $SourcePath) { $SourcePath = Join-Path $repo 'tool-logo.png' }
if (-not $OutputPath) {
    $OutputPath = Join-Path $repo 'src\public\icons\tool.svg'
}

$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not (Test-Path $SourcePath)) { throw "Source logo not found: $SourcePath" }

Write-Host "Source: $SourcePath" -ForegroundColor Cyan

$src = [System.Drawing.Image]::FromFile($SourcePath)
try {
    # --- downscale into a 32bpp surface so we have an alpha channel to work with ---
    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)))
    } finally {
        $g.Dispose()
    }
} finally {
    $src.Dispose()
}

# --- pull pixels into a byte array (BGRA) ---
$rect = New-Object System.Drawing.Rectangle(0, 0, $Size, $Size)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
                      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $Size)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

# Background colour sampled from the top-left corner.
$bgB = $bytes[0]; $bgG = $bytes[1]; $bgR = $bytes[2]
Write-Host ("Background sampled: R={0} G={1} B={2} (tolerance {3})" -f $bgR, $bgG, $bgB, $Tolerance)

# --- flood fill from every edge pixel; only connected background becomes transparent ---
$visited = New-Object 'bool[]' ($Size * $Size)
$stack = New-Object 'System.Collections.Generic.Stack[int]'

for ($i = 0; $i -lt $Size; $i++) {
    foreach ($p in @($i, (($Size - 1) * $Size + $i), ($i * $Size), ($i * $Size + $Size - 1))) {
        if (-not $visited[$p]) { $visited[$p] = $true; $stack.Push($p) }
    }
}

$cleared = 0
while ($stack.Count -gt 0) {
    $p = $stack.Pop()
    $y = [int][math]::Floor($p / $Size)
    $x = $p - ($y * $Size)
    $o = ($y * $stride) + ($x * 4)

    if ($bytes[$o + 3] -eq 0) { continue }
    $dB = [math]::Abs([int]$bytes[$o]     - [int]$bgB)
    $dG = [math]::Abs([int]$bytes[$o + 1] - [int]$bgG)
    $dR = [math]::Abs([int]$bytes[$o + 2] - [int]$bgR)
    if ($dR -gt $Tolerance -or $dG -gt $Tolerance -or $dB -gt $Tolerance) { continue }

    $bytes[$o + 3] = 0
    $cleared++

    foreach ($d in @(@(1, 0), @(-1, 0), @(0, 1), @(0, -1))) {
        $nx = $x + $d[0]; $ny = $y + $d[1]
        if ($nx -lt 0 -or $ny -lt 0 -or $nx -ge $Size -or $ny -ge $Size) { continue }
        $np = $ny * $Size + $nx
        if ($visited[$np]) { continue }
        $visited[$np] = $true
        $stack.Push($np)
    }
}

[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bmp.UnlockBits($data)
Write-Host ("Background pixels cleared: {0} of {1}" -f $cleared, ($Size * $Size))

# --- encode to PNG, then wrap in SVG ---
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Dispose()
$bmp.Dispose()

$b64 = [Convert]::ToBase64String($png)
$svg = @"
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 $Size $Size" width="$Size" height="$Size"
     role="img" aria-label="AI Builder Credit Analyzer">
  <title>AI Builder Credit Analyzer</title>
  <image x="0" y="0" width="$Size" height="$Size" href="data:image/png;base64,$b64" />
</svg>
"@

$outDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
Set-Content -Path $OutputPath -Value $svg -Encoding UTF8 -NoNewline

$kb = [math]::Round((Get-Item $OutputPath).Length / 1KB, 1)
Write-Host "Wrote $OutputPath ($kb KB)" -ForegroundColor Green
