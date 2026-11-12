# 账号体系 + 云端歌单接口冒烟测试
#
#   powershell -File scripts/api-test.ps1 [-Base http://127.0.0.1:8787] [-AdminPassword admin888]
#
# 会在 D1 里建一个随机测试用户（跑完自动删除），不会影响正式数据。
param(
  [string]$Base = 'http://127.0.0.1:8787',
  [string]$AdminPassword = 'admin888'
)

$bodyFile = Join-Path $env:TEMP 'cm_body.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$script:failures = 0

function Req($method, $path, $bodyObj, $token) {
  $a = @('-s', '-m', '25', '-X', $method, ($Base + $path), '-H', 'Content-Type: application/json', '-w', "`n%{http_code}")
  if ($token) { $a += @('-H', ('Authorization: Bearer ' + $token)) }
  if ($null -ne $bodyObj) {
    [System.IO.File]::WriteAllText($bodyFile, ($bodyObj | ConvertTo-Json -Compress -Depth 8), $utf8)
    $a += @('--data-binary', ('@' + $bodyFile))
  }
  $text = ((& curl.exe @a 2>$null) -join "`n")
  $idx = $text.LastIndexOf("`n")
  $code = $text.Substring($idx + 1)
  $payload = $text.Substring(0, $idx)
  $data = $null
  try { $data = $payload | ConvertFrom-Json } catch {}
  return @{ ok = ($code -eq '200'); code = $code; data = $data; raw = $payload }
}

function Check($name, $cond, $extra) {
  if ($cond) { Write-Output ("  PASS  {0}" -f $name) }
  else { Write-Output ("  FAIL  {0}  {1}" -f $name, $extra); $script:failures++ }
}

$user = 'test_' + (Get-Random -Maximum 99999)
$pass = 'pw' + (Get-Random -Maximum 999999)

Write-Output "target: $Base   user: $user"

Write-Output '[1] admin login'
$r = Req POST '/api/admin/login' @{ password = $AdminPassword } $null
Check 'admin login 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)
if (-not $r.ok) { exit 1 }
$admin = $r.data.token

Write-Output '[2] admin auth required'
$r = Req GET '/api/admin/users' $null $null
Check 'users list without token -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)

Write-Output '[3] create user'
$r = Req POST '/api/admin/users' @{ username = $user; password = $pass } $admin
Check 'create user 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)

Write-Output '[4] duplicate username -> 409'
$r = Req POST '/api/admin/users' @{ username = $user; password = $pass } $admin
Check 'duplicate -> 409' ($r.code -eq '409') ("code={0}" -f $r.code)

Write-Output '[5] user login'
$r = Req POST '/api/auth/login' @{ username = $user; password = 'wrong' } $null
Check 'wrong password -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)
$r = Req POST '/api/auth/login' @{ username = $user; password = $pass } $null
Check 'user login 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)
if (-not $r.ok) { exit 1 }
$ut = $r.data.token

Write-Output '[6] token isolation'
$r = Req GET '/api/playlists' $null $null
Check 'anon -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)
$r = Req GET '/api/playlists' $null $admin
Check 'admin token as user -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)
$r = Req GET '/api/playlists' $null 'aaa.bbb.ccc'
Check 'forged token -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)

Write-Output '[7] playlist crud'
$tracks = @(
  @{ key = 'n:1'; title = 'T1'; artist = 'A'; album = 'B'; durationSec = 200; platform = 'netease'; platformId = '1' },
  @{ key = 'n:2'; title = 'T2'; artist = 'A'; album = 'B'; durationSec = 210; platform = 'netease'; platformId = '2' }
)
$r = Req POST '/api/playlists' @{ name = 'list1'; platform = 'netease'; tracks = $tracks } $ut
Check 'save playlist 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)
$pid1 = $r.data.id
$r = Req GET ("/api/playlists/" + $pid1) $null $ut
Check 'read playlist 200' ($r.ok -and $r.data.name -eq 'list1') ("code={0}" -f $r.code)
$r = Req GET '/api/playlists' $null $ut
Check 'list shows 1 playlist' ($r.data.Count -eq 1) ("count={0}" -f $r.data.Count)
$r = Req DELETE ("/api/playlists/" + $pid1) $null $ut
Check 'delete playlist 200' $r.ok ("code={0}" -f $r.code)

Write-Output '[8] /api/me'
$r = Req GET '/api/me' $null $ut
Check 'me returns username' ($r.ok -and $r.data.username -eq $user) ("code={0} body={1}" -f $r.code, $r.raw)

Write-Output '[9] quark cookie sync'
$r = Req GET '/api/settings/quark' $null $null
Check 'cookie GET without token -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)
$r = Req GET '/api/settings/quark' $null $ut
Check 'cookie GET empty' ($r.ok -and $r.data.hasCookie -eq $false) ("code={0} body={1}" -f $r.code, $r.raw)
$r = Req POST '/api/settings/quark' @{ cookie = '__pus=abc; __puus=xyz' } $ut
Check 'cookie POST 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)
$r = Req GET '/api/settings/quark' $null $ut
Check 'cookie roundtrip' ($r.ok -and $r.data.cookie -eq '__pus=abc; __puus=xyz') ("code={0} body={1}" -f $r.code, $r.raw)
$r = Req POST '/api/settings/quark' @{ cookie = '__pus=new' } $ut
Check 'cookie overwrite 200' $r.ok ("code={0}" -f $r.code)
$r = Req GET '/api/settings/quark' $null $ut
Check 'cookie overwritten' ($r.data.cookie -eq '__pus=new') ("body={0}" -f $r.raw)
$r = Req DELETE '/api/settings/quark' $null $ut
Check 'cookie DELETE 200' $r.ok ("code={0}" -f $r.code)
$r = Req GET '/api/settings/quark' $null $ut
Check 'cookie cleared' ($r.data.hasCookie -eq $false) ("body={0}" -f $r.raw)

Write-Output '[10] favorites'
$r = Req GET '/api/favorites' $null $null
Check 'favorites GET without token -> 401' ($r.code -eq '401') ("code={0}" -f $r.code)
$r = Req GET '/api/favorites' $null $ut
$favList = @($r.data | Where-Object { $null -ne $_ })
Check 'favorites GET empty' ($r.ok -and $favList.Count -eq 0) ("code={0} body={1}" -f $r.code, $r.raw)
$favTrack = @{ key = 'netease:999'; title = 'FavSong'; artist = 'FA'; album = 'FB'; durationSec = 100; platform = 'netease'; platformId = '999' }
$r = Req POST '/api/favorites' @{ key = $favTrack.key; track = $favTrack } $ut
Check 'favorite add 200' $r.ok ("code={0} body={1}" -f $r.code, $r.raw)
$r = Req GET '/api/favorites' $null $ut
$favList = @($r.data | Where-Object { $null -ne $_ })
Check 'favorite listed' ($favList.Count -eq 1 -and $favList[0].track.title -eq 'FavSong') ("body={0}" -f $r.raw)
$r = Req POST '/api/favorites' @{ key = $favTrack.key; track = $favTrack } $ut
Check 'favorite add idempotent' $r.ok ("code={0}" -f $r.code)
$r = Req GET '/api/favorites' $null $ut
$favList = @($r.data | Where-Object { $null -ne $_ })
Check 'favorite still single' ($favList.Count -eq 1) ("count={0}" -f $favList.Count)
$r = Req DELETE ('/api/favorites/' + [uri]::EscapeDataString($favTrack.key)) $null $ut
Check 'favorite delete 200' $r.ok ("code={0}" -f $r.code)
$r = Req GET '/api/favorites' $null $ut
$favList = @($r.data | Where-Object { $null -ne $_ })
$active = @($favList | Where-Object { -not $_.deleted })
Check 'favorite soft-deleted (tombstone)' ($active.Count -eq 0 -and $favList.Count -eq 1) ("body={0}" -f $r.raw)
$r = Req POST '/api/favorites' @{ key = $favTrack.key; track = $favTrack } $ut
$r = Req GET '/api/favorites' $null $ut
$favList = @($r.data | Where-Object { $null -ne $_ })
$active = @($favList | Where-Object { -not $_.deleted })
Check 'favorite revived after re-add' ($active.Count -eq 1) ("body={0}" -f $r.raw)

Write-Output '[11] cleanup test user'
$users = (Req GET '/api/admin/users' $null $admin).data
$uid = ($users | Where-Object { $_.username -eq $user }).id
$r = Req DELETE ("/api/admin/users/" + $uid) $null $admin
Check 'delete test user 200' $r.ok ("code={0}" -f $r.code)

if ($script:failures -eq 0) { Write-Output 'ALL PASS' }
else { Write-Output ("FAILURES: {0}" -f $script:failures); exit 1 }
