GET https://bisdelgh.com/api/xx1/products.php
Headers:
  X-API-Key: your_api_key_here
  X-API-Secret: your_api_secret_here



  {
  "success": true,
  "code": 200,
  "data": {
    "agent_id": 1,
    "business_name": "My Business",
    "currency": "GHS",
    "products": [
      {
        "product_id": 1,
        "name": "MTN 1GB Daily",
        "data_volume": "1GB",
        "validity_days": 1,
        "network": "MTN",
        "category": "Daily Bundles",
        "api_price": 4.50,
        "has_custom_price": true
      }
    ]
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}


{
  "success": true,
  "code": 200,
  "data": {
    "agent_id": 1,
    "business_name": "My Business",
    "currency": "GHS",
    "products": [
      {
        "product_id": 1,
        "name": "MTN 1GB Daily",
        "data_volume": "1GB",
        "validity_days": 1,
        "network": "MTN",
        "category": "Daily Bundles",
        "api_price": 4.50,
        "has_custom_price": true
      }
    ]
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}


[10/22, 12:45 PM] MystiwanEbiz: }
GET /balance.php
Returns your current wallet balance, total spent, and recent transactions.

Headers: X-API-Key, X-API-Secret

Response (200):

{
  "success": true,
  "code": 200,
  "data": {
    "agent_id": 1,
    "business_name": "My Business",
    "wallet_balance": 150.00,
    "total_spent": 450.00,
    "total_orders": 23,
    "currency": "GHS",
    "recent_transactions": [
      {
        "id": 1,
        "amount": 100.00,
        "type": "deposit",
        "description": "Wallet top-up",
        "status": "completed",
        "created_at": "2026-06-05 10:00:00"
      }
    ]
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}
[10/22, 12:48 PM] MystiwanEbiz: {
  "product_id": 1,
  "phone": "0541234567",
  "quantity": 1,
  "external_order_id": "optional-your-id"
}

{
  "success": true,
  "code": 201,
  "data": {
    "success": true,
    "order_id": 100,
    "order_reference": "XX1-ABC123-1685961600",
    "main_order_id": 15000,
    "product": "MTN 1GB Daily",
    "phone": "0541234567",
    "quantity": 1,
    "unit_price": 4.50,
    "total_amount": 4.50,
    "status": "pending",
    "balance_after": 145.50
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}

{
  "success": false,
  "code": 400,
  "error": "Insufficient wallet balance",
  "details": {
    "balance": 2.00,
    "required": 4.50
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}


{
  "success": true,
  "code": 200,
  "data": {
    "order_id": 100,
    "order_reference": "XX1-ABC123-1685961600",
    "external_order_id": null,
    "product_name": "MTN 1GB Daily",
    "data_volume": "1GB",
    "customer_phone": "0541234567",
    "quantity": 1,
    "unit_price": 4.50,
    "total_amount": 4.50,
    "status": "completed",
    "created_at": "2026-06-05 10:00:00",
    "updated_at": "2026-06-05 10:05:00"
  },
  "timestamp": "2026-06-05T12:00:00+00:00"
}

Base URL : https://api.bisdelgh.com/api/xx1


api keys are stored in edge function secrets as
BISDEL_DB for database key and
BISDEL_SECRET_KEY for the secret key