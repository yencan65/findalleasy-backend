
# Affiliate / Satıcı Paneli Entegrasyon Webhook Dökümanı

**Amaç:** FindAllEasy kupon/komisyon indirimlerini satıcı/affiliate paneline yansıtmak ve sipariş onaylandıktan sonra ödül & kupon akışını kesinleştirmek.

## 1) Sipariş Onayı Webhook'u → `POST /webhooks/order-confirmed` (örnek)
```json
{
  "orderId": "ORD-2025-1109-XYZ",
  "userId": "USER-123",
  "amount": 2499.00,
  "currency": "TRY",
  "affiliate": "trendyol",
  "commissionBase": 124.95,
  "coupon": {
    "code": "FAE-1A2B3C",
    "applied": true,
    "commissionOffset": 50.00
  },
  "lineItems": [
    { "sku": "SKU-1", "qty": 1, "price": 2499.00 }
  ],
  "status": "CONFIRMED",
  "ts": "2025-11-09T12:00:00Z"
}
```

**İş Mantığı:**  
- `coupon.applied` true ise `commissionBase - commissionOffset` kadar **komisyon azaltılır**.  
- Sipariş `CONFIRMED` olduğunda kullanıcı ödülleri yazılır: kendi alışverişi **%0.1**, davet eden için (varsa) **%0.5** sadece **ilk siparişte**.

## 2) Sipariş İptali Webhook'u → `POST /webhooks/order-cancelled`
```json
{
  "orderId": "ORD-2025-1109-XYZ",
  "reason": "customer_request"
}
```
**İş Mantığı:** İade/iptal olduğunda ilgili ödül/kupon kayıtları geri alınır.

## 3) Komisyon Ödemesi Webhook'u → `POST /webhooks/commission-paid`
```json
{
  "orderId": "ORD-2025-1109-XYZ",
  "affiliate": "trendyol",
  "paid": true,
  "paidAmount": 74.95,
  "ts": "2025-11-10T09:00:00Z"
}
```

---

## Güvenlik
- Webhook çağrılarına `X-Signature: sha256=...` imzası ekleyin. Secret `.env` > `WEBHOOK_SECRET` değeriyle HMAC doğrulayın.
- IP allowlist veya mTLS önerilir.
- İstek başına **idempotency-key** kullanın.

## Captcha & Rate-Limit
- Kullanıcı etkileşimli uçlarda **Turnstile/hCaptcha** doğrulaması zorunlu; header: `X-Captcha: <token>`.
- `/api/referral/*` ve `/api/coupons/*` için rate-limit uygulanır.

