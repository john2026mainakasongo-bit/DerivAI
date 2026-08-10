$ErrorActionPreference = "Stop"
$project = "$HOME\Desktop\DerivAI"
Set-Location $project
npm install
npm run build
if ($LASTEXITCODE -ne 0) { throw "BUILD FAILED — push stopped." }
git add .
if (git status --porcelain) { git commit -m "V26 structural early entry signal engine" }
git push origin main
if ($LASTEXITCODE -ne 0) { throw "Git push failed." }
Write-Host "V26 pushed successfully. Render should auto-deploy." -ForegroundColor Green
