Add-Type -AssemblyName System.Drawing

$outDir = Join-Path (Split-Path $PSScriptRoot -Parent) "icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($s in 16, 32, 48, 128) {
    $bmp = [System.Drawing.Bitmap]::new([int]$s, [int]$s)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $r = [Math]::Max(2.0, $s * 0.24)
    $d = $r * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($s - $d, 0, $d, $d, 270, 90)
    $path.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
    $path.AddArc(0, $s - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $p1 = [System.Drawing.PointF]::new(0, 0)
    $p2 = [System.Drawing.PointF]::new($s, $s)
    $c1 = [System.Drawing.Color]::FromArgb(255, 96, 165, 250)
    $c2 = [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new($p1, $p2, $c1, $c2)
    $g.FillPath($brush, $path)

    $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, [float]([Math]::Max(1.1, $s * 0.115)))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $cx = $s / 2.0
    $w = $s * 0.26
    $h = $s * 0.15
    foreach ($offset in @((-1 * $s * 0.13), ($s * 0.11))) {
        $y = $s * 0.5 + $offset
        $pts = @(
            [System.Drawing.PointF]::new([float]($cx - $w), [float]($y - $h / 2)),
            [System.Drawing.PointF]::new([float]$cx, [float]($y + $h / 2)),
            [System.Drawing.PointF]::new([float]($cx + $w), [float]($y - $h / 2))
        )
        $g.DrawLines($pen, $pts)
    }

    $g.Dispose()
    $bmp.Save("$outDir\icon$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}

Get-ChildItem $outDir | Select-Object Name, Length
