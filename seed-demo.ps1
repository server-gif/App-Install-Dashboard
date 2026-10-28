param([string]$BaseUrl = "http://127.0.0.1:8787")
$base = $BaseUrl
$btmp = Join-Path $env:TEMP "seed-body.json"
$hdr = Join-Path $env:TEMP "seed-hdr.txt"

function Post($path, $body, $cookie, $apikey, $dash) {
  $a = @("-s", "-D", $hdr, "-X", "POST", ($base + $path))
  if ($body -ne "") { Set-Content -Path $btmp -Value $body -Encoding Ascii -NoNewline; $a += @("-H", "Content-Type: application/json", "--data-binary", "@$btmp") }
  if ($cookie) { $a += @("-H", "Cookie: $cookie") }
  if ($apikey) { $a += @("-H", "X-API-Key: $apikey") }
  if ($dash) { $a += @("-H", "X-Requested-With: dashboard") }
  $r = (& curl.exe @a) -join ""
  $sc = Select-String -Path $hdr -Pattern "^set-cookie:\s*(session=[^;]+)"
  $ck = if ($sc) { $sc[0].Matches[0].Groups[1].Value } else { "" }
  return @{ body = $r; cookie = $ck }
}

Write-Host "resetting local demo data"
npx wrangler d1 execute installs-db --local --command "DELETE FROM installs; DELETE FROM user_apps; DELETE FROM apps; DELETE FROM users; DELETE FROM sqlite_sequence;" | Out-Null

$ck = (Post "/api/setup" '{"username":"demo","password":"Demo12345"}' "" "" 1).cookie
Write-Host "admin session: $($ck.Substring(0,20))..."

$apps = @(
  @{ n = "My Game"; p = "com.x.mygame" },
  @{ n = "My Clock"; p = "com.x.myclock" },
  @{ n = "Shop Lite"; p = "" }
)
$keys = @()
foreach ($a in $apps) {
  $body = if ($a.p) { '{"name":"' + $a.n + '","package_name":"' + $a.p + '"}' } else { '{"name":"' + $a.n + '"}' }
  $j = ((Post "/api/apps" $body $ck "" 1).body | ConvertFrom-Json)
  $keys += @{ name = $a.n; key = $j.api_key }
  Write-Host ("app {0} id={1}" -f $a.n, $j.id)
}

# installs across countries + days so the matrix has shape
$data = @(
  @{ app = 0; dev = "g-01"; cc = "IN"; days = 0; plat = "android"; v = "2.1.0"; tag = "organic" },
  @{ app = 0; dev = "g-02"; cc = "IN"; days = 1; plat = "android"; v = "2.1.0"; tag = "ads" },
  @{ app = 0; dev = "g-03"; cc = "IN"; days = 2; plat = "android"; v = "2.0.0"; tag = "organic" },
  @{ app = 0; dev = "g-04"; cc = "US"; days = 0; plat = "ios"; v = "2.1.0"; tag = "organic" },
  @{ app = 0; dev = "g-05"; cc = "US"; days = 3; plat = "ios"; v = "2.0.0"; tag = "referral" },
  @{ app = 0; dev = "g-06"; cc = "GB"; days = 4; plat = "android"; v = "2.1.0"; tag = "" },
  @{ app = 0; dev = "g-07"; cc = "DE"; days = 6; plat = "android"; v = "2.1.0"; tag = "ads" },
  @{ app = 0; dev = "g-08"; cc = "JP"; days = 9; plat = "ios"; v = "2.0.0"; tag = "" },
  @{ app = 0; dev = "g-09"; cc = "IN"; days = 12; plat = "android"; v = "1.9.0"; tag = "organic" },
  @{ app = 0; dev = "g-10"; cc = "BR"; days = 20; plat = "android"; v = "2.1.0"; tag = "organic" },
  @{ app = 1; dev = "c-01"; cc = "IN"; days = 0; plat = "android"; v = "1.4.0"; tag = "organic" },
  @{ app = 1; dev = "c-02"; cc = "IN"; days = 2; plat = "android"; v = "1.4.0"; tag = "ads" },
  @{ app = 1; dev = "c-03"; cc = "CA"; days = 5; plat = "ios"; v = "1.3.0"; tag = "" },
  @{ app = 1; dev = "c-04"; cc = "AU"; days = 8; plat = "ios"; v = "1.4.0"; tag = "organic" },
  @{ app = 1; dev = "c-05"; cc = "US"; days = 15; plat = "web"; v = "1.2.0"; tag = "seo" },
  @{ app = 2; dev = "s-01"; cc = "IN"; days = 1; plat = "android"; v = "3.0.1"; tag = "organic" },
  @{ app = 2; dev = "s-02"; cc = "AE"; days = 3; plat = "android"; v = "3.0.0"; tag = "ads" },
  @{ app = 2; dev = "s-03"; cc = "SA"; days = 7; plat = "android"; v = "3.0.1"; tag = "" },
  @{ app = 2; dev = "s-04"; cc = "Indonesia"; days = 11; plat = "android"; v = "3.0.1"; tag = "organic" },
  @{ app = 2; dev = "s-05"; cc = "ZA"; days = 25; plat = "ios"; v = "2.9.0"; tag = "" }
)
foreach ($d in $data) {
  $ts = (Get-Date).ToUniversalTime().AddDays(-$d.days).ToString("yyyy-MM-ddTHH:mm:ssZ")
  $pkg = $apps[$d.app].p
  $body = '{"device_id":"' + $d.dev + '","platform":"' + $d.plat + '","app_version":"' + $d.v + '","country":"' + $d.cc + '","installed_at":"' + $ts + '"'
  if ($pkg) { $body += ',"package_name":"' + $pkg + '"' }
  if ($d.tag) { $body += ',"install_tag":"' + $d.tag + '"' }
  $body += '}'
  Post "/api/track/install" $body "" $keys[$d.app].key 0 | Out-Null
}
Write-Host ("seeded {0} install events" -f $data.Count)

Post "/api/users" '{"username":"ravi","password":"Ravi@12345","app_ids":[1]}' $ck "" 1 | Out-Null
Write-Host "sub user 'ravi' -> only app id 1 (My Game)"
Write-Host "DONE. Login: demo / Demo12345  (sub user: ravi / Ravi@12345)"
