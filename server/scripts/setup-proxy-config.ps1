Write-Host "== FindAllEasy Proxy Config Bootstrap ==" -ForegroundColor Cyan

$dir = "server\adapters\config"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# KREDİ KAYDETME: placeholder bırak, gerçeklerini ENV ile ver
$proxyJson = @"
{
  "proxies": [
    { "protocol": "http", "host": "YOUR_PROXY_HOST_1", "port": 8000, "username": "YOUR_USER", "password": "YOUR_PASS", "country": "TR" },
    { "protocol": "http", "host": "YOUR_PROXY_HOST_2", "port": 8000, "username": "YOUR_USER", "password": "YOUR_PASS", "country": "DE" }
  ]
}
"@

$proxyJson | Out-File -Encoding UTF8 -FilePath "$dir\proxy-list.json"
Write-Host "OK: proxy-list.json yazildi -> $dir\proxy-list.json" -ForegroundColor Green

Write-Host "ENV önerisi (bu session):" -ForegroundColor Yellow
Write-Host '$env:FINDALLEASY_PROXY_ENABLED="1"' -ForegroundColor Yellow
Write-Host 'NOT: Gerçek proxy credentiallarını dosyaya gömme. ENV veya secret store kullan.' -ForegroundColor Yellow
