param([string]$BaseUrl = "http://127.0.0.1:8787", [string]$D1Target = "local")
$ErrorActionPreference = "Continue"
$base = $BaseUrl
$script:pass = 0; $script:fail = 0
$hdr = Join-Path $env:TEMP "hdr.txt"
$btmp = Join-Path $env:TEMP "body.json"

function Check($name, $actual, $expect) {
  if ("$actual" -like "*$expect*") { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  FAIL  $name`n        got : $actual`n        want: *$expect*" -ForegroundColor Red }
}

# api METHOD PATH BODY COOKIE DASH APIKEY  (always pass all 6 positionally)
function api($method, $path, $body, $cookie, $dash, $apikey) {
  $a = @("-s", "-D", $hdr, "-X", $method, ($base + $path))
  if ($body -ne "") {
    # PS 5.1 mangles embedded quotes for native exes -> send body from a file instead
    Set-Content -Path $btmp -Value $body -Encoding Ascii -NoNewline
    $a += @("-H", "Content-Type: application/json", "--data-binary", "@$btmp")
  }
  if ($cookie -ne "") { $a += @("-H", "Cookie: $cookie") }
  if ($dash -eq 1) { $a += @("-H", "X-Requested-With: dashboard") }
  if ($apikey -ne "") { $a += @("-H", "X-API-Key: $apikey") }
  $a += @("-w", "|ST:%{http_code}")
  # join with newline so multi-line bodies (CSV) keep their row structure
  $out = (& curl.exe @a) -join "`n"
  $status = if ($out -match "\|ST:(\d+)$") { $Matches[1] } else { "?" }
  $bodyOut = $out -replace "\|ST:\d+$", ""
  $sc = Select-String -Path $hdr -Pattern "^set-cookie:\s*(session=[^;]+)"
  $newCookie = if ($sc) { $sc[0].Matches[0].Groups[1].Value } else { "" }
  return @{ status = $status; body = $bodyOut; cookie = $newCookie }
}
function G($path, $ck) { api GET $path "" $ck 0 "" }              # GET, no csrf header needed
function P($path, $body, $ck) { api POST $path $body $ck 1 "" }   # POST with dashboard header
function T($body, $key) { api POST "/api/track/install" $body "" 0 $key }

Write-Host "--- reset DB ($D1Target) @ $base ---"
npx wrangler d1 execute installs-db --$D1Target --command "DELETE FROM installs; DELETE FROM user_apps; DELETE FROM apps; DELETE FROM users; DELETE FROM sqlite_sequence;" | Out-Null

Write-Host "`n[1] setup: main admin"
Check "needs_setup true" (G "/api/setup-status" "").body "true"
$r = P "/api/setup" '{"username":"mainadmin","password":"SuperSecret123"}' ""
$ADMIN = $r.cookie
Check "admin role" $r.body '"role":"admin"'
Check "session cookie issued" ($ADMIN.Length -gt 20) "True"
Check "2nd setup blocked" (P "/api/setup" '{"username":"hacker","password":"Hacker12345"}' "").status "409"
Check "needs_setup false now" (G "/api/setup-status" "").body "false"

Write-Host "`n[2] apps + api keys"
$A = ((P "/api/apps" '{"name":"My Game","package_name":"com.x.mygame"}' $ADMIN).body | ConvertFrom-Json)
Check "app A created with key" ($A.api_key -like "ik_*") "True"
$B = ((P "/api/apps" '{"name":"My Clock"}' $ADMIN).body | ConvertFrom-Json)
Check "app B created with key" ($B.api_key -like "ik_*") "True"
Check "app name required" (P "/api/apps" '{}' $ADMIN).status "400"

Write-Host "`n[3] track install API (per-device dedupe)"
foreach ($d in @("dev1", "dev2", "dev3")) {
  Check "new install $d" (T ('{"device_id":"' + $d + '","platform":"android","app_version":"1.0.0"}') $A.api_key).body '"new":true'
}
Check "duplicate dev1 ignored" (T '{"device_id":"dev1","platform":"android"}' $A.api_key).body '"new":false'
Check "app B install dev9" (T '{"device_id":"dev9","platform":"ios"}' $B.api_key).body '"new":true'
Check "same device, other app counts" (T '{"device_id":"dev1","platform":"ios"}' $B.api_key).body '"new":true'
Check "bad api key 401" (T '{"device_id":"z"}' "ik_bad").status "401"
Check "missing api key 401" (api POST "/api/track/install" '{"device_id":"z"}' "" 0 "").status "401"
Check "missing device_id 400" (T '{}' $A.api_key).status "400"

Write-Host "`n[4] admin stats"
$s = G "/api/stats?app_id=all&days=7" $ADMIN
Check "total = 5 installs" $s.body '"total":5'
Check "daily series present" $s.body '"series"'
Check "platform breakdown" $s.body '"k":"android"'
Check "country breakdown present" $s.body '"country"'
Check "per app breakdown" $s.body "My Game"
Check "recent list" $s.body '"recent"'
Check "app A only = 3" (G ("/api/stats?app_id=" + $A.id) $ADMIN).body '"total":3'
Check "app B only = 2" (G ("/api/stats?app_id=" + $B.id) $ADMIN).body '"total":2'

Write-Host "`n[5] create sub user with app-A-only permission"
$r = P "/api/users" ('{"username":"ravi","password":"Ravi@12345","app_ids":[' + $A.id + ']}') $ADMIN
$RAVI = ($r.body | ConvertFrom-Json).id
Check "sub user created" $r.status "201"
Check "dup username 409" (P "/api/users" '{"username":"ravi","password":"Ravi@12345","app_ids":[]}' $ADMIN).status "409"
Check "short password rejected" (P "/api/users" '{"username":"bob","password":"short","app_ids":[]}' $ADMIN).body "at least 8"
Check "bad username rejected" (P "/api/users" '{"username":"a b","password":"Abcd1234","app_ids":[]}' $ADMIN).body "Username"

Write-Host "`n[6] sub user login + server-side permission enforcement"
$r = P "/api/login" '{"username":"ravi","password":"Ravi@12345"}' ""
$SUB = $r.cookie
Check "sub login ok" $r.body '"role":"user"'
Check "wrong password 401" (P "/api/login" '{"username":"ravi","password":"wrongpass1"}' "").status "401"
Check "sub session cookie" ($SUB.Length -gt 20) "True"
$sa = G "/api/apps" $SUB
Check "sub sees only My Game" $sa.body '"name":"My Game"'
Check "sub does NOT see My Clock" ($sa.body -notmatch "My Clock") "True"
Check "sub gets NO api_key" ($sa.body -notmatch "api_key") "True"
Check "admin DOES see api_key" (G "/api/apps" $ADMIN).body "api_key"
Check "sub stats allowed app" (G ("/api/stats?app_id=" + $A.id) $SUB).body '"total":3'
Check "sub stats other app 403" (G ("/api/stats?app_id=" + $B.id) $SUB).status "403"
Check "sub 'all' = own apps only" (G "/api/stats?app_id=all" $SUB).body '"total":3'
Check "sub cannot create app" (P "/api/apps" '{"name":"x"}' $SUB).status "403"
Check "sub cannot list users" (G "/api/users" $SUB).status "403"
Check "sub cannot delete app" (api DELETE ("/api/apps/" + $A.id) "" $SUB 1 "").status "403"
Check "sub cannot rotate key" (P ("/api/apps/" + $B.id + "/rotate-key") "" $SUB).status "403"
Check "anonymous /api/apps 401" (G "/api/apps" "").status "401"
Check "anonymous stats 401" (G "/api/stats" "").status "401"
Check "CSRF (no header) blocked" (api POST "/api/apps" '{"name":"x"}' $ADMIN 0 "").status "400"

Write-Host "`n[7] admin changes sub user's app permission"
Check "update ok" (api PUT ("/api/users/" + $RAVI) ('{"app_ids":[' + $B.id + ']}') $ADMIN 1 "").body '"ok":true'
Check "sub now sees My Clock" (G "/api/apps" $SUB).body "My Clock"
Check "sub lost My Game access" (G ("/api/stats?app_id=" + $A.id) $SUB).status "403"
Check "sub all-total now 2 (app B)" (G "/api/stats?app_id=all" $SUB).body '"total":2'
Check "cannot modify main admin" (api PUT "/api/users/1" '{"app_ids":[]}' $ADMIN 1 "").body "Main admin cannot"

Write-Host "`n[8] rotate key, password change, logout"
$NEWKEY = ((P ("/api/apps/" + $B.id + "/rotate-key") "" $ADMIN).body | ConvertFrom-Json).api_key
Check "new key returned" ($NEWKEY -like "ik_*") "True"
Check "old key now 401" (T '{"device_id":"q"}' $B.api_key).status "401"
Check "new key works" (T '{"device_id":"q"}' $NEWKEY).body '"new":true'
Check "own password change" (P "/api/password" '{"current":"Ravi@12345","new":"Ravi@99999"}' $SUB).body '"ok":true'
Check "login with new password" (P "/api/login" '{"username":"ravi","password":"Ravi@99999"}' "").body '"role":"user"'
Check "wrong current pw 403" (P "/api/password" '{"current":"nope12345","new":"Abcd12345"}' $SUB).status "403"
Check "UI served at /" (G "/" "").body "Install Dashboard"
Check "logout ok" (P "/api/logout" "" $SUB).body '"ok":true'

Write-Host "`n[9] delete app cascades data"
$r = api DELETE ("/api/apps/" + $A.id) "" $ADMIN 1 ""
Check "delete ok" $r.body '"ok":true'
Check "app A installs gone (total 3)" (G "/api/stats?app_id=all&days=7" $ADMIN).body '"total":3'
Check "sub user survives app delete" (G "/api/users" $ADMIN).body "ravi"

Write-Host "`n[10] misc"
Check "404 on unknown api" (G "/api/nope" $ADMIN).status "404"
Check "delete sub user" (api DELETE ("/api/users/" + $RAVI) "" $ADMIN 1 "").body '"ok":true'
Check "sub session dead after delete" (G "/api/apps" $SUB).status "401"

Write-Host "`n[11] new flow: package_name, country name/code, install tag, client timestamps"
$nowUtc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$oldUtc = (Get-Date).ToUniversalTime().AddDays(-40).ToString("yyyy-MM-ddTHH:mm:ssZ")
$today = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$epochNow = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

$C = ((P "/api/apps" '{"name":"Ctry App","package_name":"com.x.ctray"}' $ADMIN).body | ConvertFrom-Json)
Check "app C created" ($C.api_key -like "ik_*") "True"

$r1 = T ('{"device_id":"c1","package_name":"com.x.ctray","country":"IN","platform":"android","app_version":"1.0.0","installed_at":"' + $nowUtc + '","install_tag":"organic"}') $C.api_key
Check "C/c1 stored with IN" $r1.body '"country":"IN"'
Check "C/c1 keeps client timestamp" ($r1.body -notmatch '"server-time"') "True"

$r2 = T '{"device_id":"c2","country":"India","platform":"android","app_version":"1.0.0"}' $C.api_key
Check "country full name -> code" $r2.body '"country":"IN"'
$r2b = T '{"device_id":"c2","country":"India"}' $C.api_key
Check "c2 duplicate still deduped" $r2b.body '"new":false'

$r3 = T ('{"device_id":"c3","country":"us","platform":"ios","installed_at":"' + $oldUtc + '"}') $C.api_key
Check "lowercase country code accepted" $r3.body '"country":"US"'
$r4 = T ('{"device_id":"c4","package_name":"com.x.ctray","country":"DE","platform":"android","install_tag":"camp,x1","installed_at":' + $epochNow + '}') $C.api_key
Check "epoch seconds accepted" ($r4.body -notmatch '"server-time"') "True"
$r5 = T '{"device_id":"c5","country":"FR","platform":"web","installed_at":"not-a-date"}' $C.api_key
Check "garbage date -> server time" $r5.body '"server-time"'
$r6 = T '{"device_id":"c6","country":"GB","platform":"web","installed_at":"2999-01-01T00:00:00Z"}' $C.api_key
Check "future date -> server time" $r6.body '"server-time"'
Check "day-only date accepted" (T ('{"device_id":"c7","country":"CA","installed_at":"' + $today + '"}') $C.api_key).body '"new":true'

Write-Host "`n[12] /api/countries - app x country matrix"
$c7 = G ("/api/countries?app_id=" + $C.id + "&days=7") $ADMIN
Check "IN row present with 2 installs" $c7.body '"country":"IN","total":2'
Check "matrix carries app column counts" $c7.body ('"by_app":{"' + $C.id + '":2}')
Check "7d excludes 40-day-old US row" ($c7.body -notmatch '"country":"US"') "True"
Check "DE present" $c7.body '"country":"DE"'
Check "apps summary included" $c7.body '"name":"Ctry App"'
$c90 = G ("/api/countries?app_id=" + $C.id + "&days=90") $ADMIN
Check "90d includes US row" $c90.body '"country":"US"'
Check "countries endpoint needs login" (G "/api/countries" "").status "401"

Write-Host "`n[13] /api/installs - stored records + filters + paging"
$all = G ("/api/installs?app_id=" + $C.id) $ADMIN
Check "7 stored rows for C" $all.body '"total":7'
Check "row carries tag" $all.body '"tag":"organic"'
Check "row carries package_name" $all.body 'com.x.ctray'
Check "row carries created_at" ($all.body -match '"created_at":"20') "True"
Check "filter country=IN -> 2" (G ("/api/installs?app_id=" + $C.id + "&country=IN") $ADMIN).body '"total":2'
Check "filter country by name works too" (G ("/api/installs?app_id=" + $C.id + "&country=India") $ADMIN).body '"total":2'
Check "filter platform=ios -> 1" (G ("/api/installs?app_id=" + $C.id + "&platform=ios") $ADMIN).body '"total":1'
Check "search q=camp finds tag" (G ("/api/installs?app_id=" + $C.id + "&q=camp") $ADMIN).body '"total":1'
Check "facets list platforms" $all.body '"platforms"'
$pf = G ("/api/installs?app_id=" + $C.id + "&per=2&page=1") $ADMIN
$ccFacet = ""
if ($pf.body -match '"countries":(\[[^\]]*\])') { $ccFacet = $Matches[1] }
Check "facet: page 1 (2 rows) still lists all 6 countries" ($ccFacet.Split(",").Count) "6"
Check "facet: all 6 country codes listed" $ccFacet "CA"
$from = (Get-Date).ToUniversalTime().AddDays(-1).ToString("yyyy-MM-dd")
$to = (Get-Date).ToUniversalTime().AddDays(1).ToString("yyyy-MM-dd")
$range = G ("/api/installs?app_id=" + $C.id + "&from=" + $from + "&to=" + $to) $ADMIN
Check "date range excludes old record" $range.body '"total":6'
$p1 = G ("/api/installs?app_id=" + $C.id + "&per=2&page=1") $ADMIN
Check "page 1 has 2 rows" $p1.body '"per_page":2'
Check "pages computed" $p1.body '"pages":4'
$p4 = G ("/api/installs?app_id=" + $C.id + "&per=2&page=4") $ADMIN
Check "last page has 1 row" (([regex]::Matches($p4.body, '"device_id"')).Count) "1"

Write-Host "`n[14] CSV export"
$csv = G ("/api/installs.csv?app_id=" + $C.id) $ADMIN
$csvRows = @(($csv.body -split "`n" | Where-Object { $_.Trim() -ne "" }))
Check "csv header row" $csvRows[0] "installed_at,recorded_at,app,package_name"
Check "csv has 1 header + 7 data rows" $csvRows.Count "8"
Check "csv quotes comma-containing tag" $csv.body '"camp,x1"'
$csvF = G ("/api/installs.csv?app_id=" + $C.id + "&country=IN") $ADMIN
Check "csv respects country filter" @((($csvF.body -split "`n") | Where-Object { $_.Trim() })).Count "3"
Check "csv content-type" ((& curl.exe -s -D - -o NUL ($base + "/api/installs.csv?app_id=" + $C.id) -H ("Cookie: " + $ADMIN)) -join " ") "text/csv"
Check "csv needs login (anonymous 401)" (G "/api/installs.csv" "").status "401"

Write-Host "`n[15] package_name backfill + mismatch + country fallback"
$D = ((P "/api/apps" '{"name":"Delta App"}' $ADMIN).body | ConvertFrom-Json)
$appsJson = ((G "/api/apps" $ADMIN).body | ConvertFrom-Json).apps
$dObj = @($appsJson | Where-Object { $_.id -eq $D.id })[0]
Check "D created (found in apps list)" $(if ($dObj) { "yes" } else { "no" }) "yes"
Check "D package_name empty before backfill" $("" + $dObj.package_name) ""
$rb = T '{"device_id":"d1","package_name":"com.x.delta","platform":"android"}' $D.api_key
Check "d1 accepted" $rb.body '"new":true'
Check "package backfilled onto app" (G "/api/apps" $ADMIN).body 'com.x.delta'
$rmis = T '{"device_id":"d2","package_name":"com.other.app"}' $D.api_key
Check "mismatched package rejected" $rmis.body "does not match"
Check "mismatch leaves row unwritten" (G ("/api/installs?app_id=" + $D.id + "&q=d2") $ADMIN).body '"total":0'
$rf = T '{"device_id":"d3","platform":"web"}' $D.api_key
$fc = ($rf.body | ConvertFrom-Json).country
Check "missing country -> ISO-2 fallback" ($fc -match "^[A-Z]{2}$") "True"
$rbad = T '{"device_id":"d4","country":"Narnia"}' $D.api_key
Check "unknown country name -> fallback, not garbage" ((($rbad.body | ConvertFrom-Json).country) -match "^[A-Z]{2}$") "True"
Check "empty JSON body rejected" (T '{}' $D.api_key).status "400"
Check "no body rejected" (T '' $D.api_key).status "400"

Write-Host "`n[16] permissions apply to the new endpoints too"
$r = P "/api/users" ('{"username":"meera","password":"Meera@12345","app_ids":[' + $C.id + ']}') $ADMIN
$MEERA = ($r.body | ConvertFrom-Json).id
$SUB2 = (P "/api/login" '{"username":"meera","password":"Meera@12345"}' "").cookie
Check "meera countries of own app" (G ("/api/countries?app_id=" + $C.id) $SUB2).body '"country":"IN"'
Check "meera blocked from app D countries" (G ("/api/countries?app_id=" + $D.id) $SUB2).status "403"
Check "meera blocked from app D installs" (G ("/api/installs?app_id=" + $D.id) $SUB2).status "403"
Check "meera blocked from app D csv" (G ("/api/installs.csv?app_id=" + $D.id) $SUB2).status "403"
$mAll = G "/api/countries?app_id=all&days=365" $SUB2
Check "meera 'all' excludes Delta App" ($mAll.body -notmatch "Delta App") "True"
$iAll = G "/api/installs?app_id=all&per=200" $SUB2
Check "meera 'all' sees 7 rows (app C only)" $iAll.body '"total":7'
$adminAll = G "/api/installs?app_id=all&per=200" $ADMIN
Check "admin 'all' sees all 13 rows" $adminAll.body '"total":13'

Write-Host "`n[17] dashboard stats: ALL countries for an app (not capped at 10)"
$W = ((P "/api/apps" '{"name":"Wide App"}' $ADMIN).body | ConvertFrom-Json)
foreach ($ccx in @("IN", "US", "DE", "FR", "GB", "CA", "BR", "JP", "AU", "AE", "ZA", "ID")) {
  T ('{"device_id":"w_' + $ccx + '","country":"' + $ccx + '","platform":"web"}') $W.api_key | Out-Null
}
$ws = (G ("/api/stats?app_id=" + $W.id + "&days=7") $ADMIN).body
$wcTxt = ""
if ($ws -match '"country":(\[[^\]]*\])') { $wcTxt = $Matches[1] }
Check "12 distinct countries all returned (no top-10 cap)" ([regex]::Matches($wcTxt, '"k":').Count) "12"

Write-Host "`n[18] app icon: resolved by package name on create + refresh endpoint"
$IC = ((P "/api/apps" '{"name":"Icon App","package_name":"com.whatsapp"}' $ADMIN).body | ConvertFrom-Json)
Check "create returns an icon_url field" (($IC.PSObject.Properties.Name -contains "icon_url")) "True"
$appsJson = ((G "/api/apps" $ADMIN).body | ConvertFrom-Json).apps
Check "/api/apps exposes icon_url per app" ((($appsJson | Where-Object { $_.id -eq $IC.id }).PSObject.Properties.Name -contains "icon_url")) "True"
$refr = P ("/api/apps/" + $IC.id + "/icon") '' $ADMIN
Check "icon refresh returns 200" $refr.status "200"
Check "icon refresh returns icon_url field" ((($refr.body | ConvertFrom-Json).PSObject.Properties.Name -contains "icon_url")) "True"
Check "icon refresh needs a package name (Wide App has none -> 400)" (P ("/api/apps/" + $W.id + "/icon") '' $ADMIN).status "400"

Write-Host "`n[19] stats + countries accept an explicit from/to range (the calendar)"
$sr = G ("/api/stats?app_id=" + $W.id + "&from=" + $from + "&to=" + $to) $ADMIN
Check "stats echoes the from date" ($sr.body -match ('"from":"' + $from)) "True"
$srTxt = ""; if ($sr.body -match '"country":(\[[^\]]*\])') { $srTxt = $Matches[1] }
Check "stats from/to returns the 12 Wide installs" ([regex]::Matches($srTxt, '"k":').Count) "12"
$pastF = (Get-Date).ToUniversalTime().AddYears(-5).ToString("yyyy-MM-dd")
$pastT = (Get-Date).ToUniversalTime().AddYears(-5).AddDays(1).ToString("yyyy-MM-dd")
Check "stats custom past range -> period 0" (G ("/api/stats?app_id=" + $W.id + "&from=" + $pastF + "&to=" + $pastT) $ADMIN).body '"period":0'
$cr = G ("/api/countries?app_id=" + $W.id + "&from=" + $from + "&to=" + $to) $ADMIN
Check "countries echoes the to date" ($cr.body -match ('"to":"' + $to)) "True"
Check "countries from/to finds IN row" $cr.body '"country":"IN"'

Write-Host "--- cleanup: leave DB empty so first visit shows 'Create main admin' ---"
npx wrangler d1 execute installs-db --$D1Target --command "DELETE FROM installs; DELETE FROM user_apps; DELETE FROM apps; DELETE FROM users; DELETE FROM sqlite_sequence;" | Out-Null
Check "setup-status back to needs_setup" (G "/api/setup-status" "").body "true"

Write-Host ("`n===== RESULT: {0} passed, {1} failed =====" -f $script:pass, $script:fail)
if ($script:fail -gt 0) { exit 1 }
