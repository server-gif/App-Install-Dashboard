Set-Location "d:\new git\app_install_count_dashboard"

Write-Host "== worker syntax =="
node --check src\index.js
if ($LASTEXITCODE -eq 0) { Write-Host "src/index.js OK" } else { Write-Host "src/index.js FAILED" }

Write-Host "== inline UI script syntax =="
$raw = Get-Content public\index.html -Raw
$js = ($raw -split "<script>")[1] -split "</script>" | Select-Object -First 1
$tmp = Join-Path $env:TEMP "ui-check.mjs"
Set-Content -Path $tmp -Value $js -Encoding UTF8
node --check $tmp
if ($LASTEXITCODE -eq 0) { Write-Host ("UI script OK (" + ($js -split "`n").Count + " lines)") } else { Write-Host "UI script FAILED" }

Write-Host "== unbalanced template/quote sniff =="
Write-Host ("backticks in file: " + ([regex]::Matches($raw, '`').Count) + " (should be even)")
Write-Host ("'boot();' present: " + ($raw -match "boot\(\);"))
Write-Host ("'</html>' present: " + ($raw -match "</html>"))

Write-Host "== ps1 parser check =="
foreach ($f in @("smoke-test.ps1", "seed-demo.ps1", "syntax-check.ps1")) {
  $errs = $null
  [void][System.Management.Automation.PSParser]::Tokenize((Get-Content $f -Raw), [ref]$errs)
  if ($errs.Count) { Write-Host ("$f -> " + $errs.Count + " PARSE ERROR(S)") -ForegroundColor Red; $errs | ForEach-Object { Write-Host ("   line " + $_.Token.StartScriptPosition.StartLineNumber + ": " + $_.Message) } }
  else { Write-Host ("$f parses clean") }
}
