param(
  [string]$Provider = "trendyol",
  [string]$UserId = "",
  [string]$MerchantUrl = "https://example.com",
  [int]$Amount = 100,
  [string]$Currency = "TRY",
  [string]$Status = "approved"
)

$ErrorActionPreference = "Stop"

if (-not $UserId) {
  throw "UserId boş. Örn: -UserId 6911f6f29e2eb5bde13f0511"
}

$prov = $Provider.Trim().ToLower()
$oid  = "TEST-" + (Get-Date -Format "HHmmss")

Write-Host "== CONTRACT ($prov) ==" -ForegroundColor Cyan
curl.exe -s "http://localhost:8080/api/aff/contract/$prov"
Write-Host ""

Write-Host "== OUT ($prov) ==" -ForegroundColor Cyan

$hdr = curl.exe -s -D - -o NUL -G "http://localhost:8080/api/aff/out/$prov" `
  --data-urlencode "url=$MerchantUrl" `
  --data-urlencode "itemId=demo" `
  --data-urlencode "title=demo" `
  --data-urlencode "userId=$UserId"

$locLine = $hdr | Select-String -Pattern '^Location:\s*(.+)$' | Select-Object -First 1
if (-not $locLine) {
  Write-Host $hdr
  throw "NO_LOCATION: /api/aff/out/$prov 302 dönmedi."
}

$loc = $locLine.Matches[0].Groups[1].Value.Trim()

$cid = ([regex]::Match($loc,'[?&]fae_click=([^&]+)')).Groups[1].Value
if (-not $cid) { $cid = ([regex]::Match($loc,'[?&]subid4=([^&]+)')).Groups[1].Value }
if (-not $cid) { $cid = ([regex]::Match($loc,'[?&]clickref=([^&]+)')).Groups[1].Value }
if (-not $cid) { $cid = ([regex]::Match($loc,'[?&]subid=([^&]+)')).Groups[1].Value }

if (-not $cid) { throw "NO_CLICKID: Location içinde click paramı yok. Location=$loc" }

Write-Host "LOCATION: $loc"
Write-Host "CLICKID : $cid"
Write-Host "ORDERID : $oid"

Write-Host "`n== POSTBACK ($prov) ==" -ForegroundColor Cyan

if ($prov -eq "trendyol") {
  $pb = curl.exe -s -G "http://localhost:8080/api/aff/postback/$prov" `
    --data-urlencode "subid4=$cid" `
    --data-urlencode "order_id=$oid" `
    --data-urlencode "order_sum=$Amount" `
    --data-urlencode "currency=$Currency" `
    --data-urlencode "payment_status=$Status"
}
elseif ($prov -eq "hepsiburada") {
  $pb = curl.exe -s -G "http://localhost:8080/api/aff/postback/$prov" `
    --data-urlencode "clickref=$cid" `
    --data-urlencode "transactionId=$oid" `
    --data-urlencode "transactionAmount=$Amount" `
    --data-urlencode "transactionCurrency=$Currency" `
    --data-urlencode "commissionStatus=$Status"
}
else {
  $pb = curl.exe -s -G "http://localhost:8080/api/aff/postback/$prov" `
    --data-urlencode "clickId=$cid" `
    --data-urlencode "orderId=$oid" `
    --data-urlencode "amount=$Amount" `
    --data-urlencode "currency=$Currency" `
    --data-urlencode "status=$Status"
}

Write-Host $pb
Write-Host "`nDONE prov=$prov cid=$cid oid=$oid userId=$UserId" -ForegroundColor Green
