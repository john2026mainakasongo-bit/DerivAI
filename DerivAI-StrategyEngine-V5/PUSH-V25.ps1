$ErrorActionPreference = "Stop"
$project = "$HOME\Desktop\DerivAI"
Set-Location $project

Write-Host "Building DerivAI V25..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "Build failed. Nothing pushed." }

git add .
git commit -m "V25 early entry no-chase analyzer" 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host "No new commit or commit already exists." -ForegroundColor Yellow }
git push origin main
if ($LASTEXITCODE -ne 0) { throw "Git push failed." }
Write-Host "V25 pushed successfully. Render can deploy main." -ForegroundColor Green
