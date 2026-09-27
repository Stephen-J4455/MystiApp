[10:30 AM, 9/27/2026] MystiwanEbiz: curl -X GET https://backend.jehucale-business.com/api/orders/ord_123456789 \
 -H "X-API-Key: YOUR_API_KEY"
[10:31 AM, 9/27/2026] MystiwanEbiz: Response👇👇
[10:31 AM, 9/27/2026] MystiwanEbiz: {
"success": true,
"data": {
"id": "ord_123456789",
"phoneNumber": "233244123456",
"network": "mtn",
"dataSize": 100,
"bundleType": "daily",
"status": "completed",
"amount": 10.00,
"createdAt": "2024-01-15T10:30:00Z",
"completedAt": "2024-01-15T10:35:00Z",
"transactionId": "txn_987654321",
"notes": "Bundle activated successfully"
}
}
[10:31 AM, 9/27/2026] MystiwanEbiz: Error Responses👇👇

401 Unauthorized
{
"success": false,
"error": "Invalid API key"
}

400 Bad Request
{
"success": false,
"error": "Invalid request format",
"details": "phoneNumber is required"
}

429 Too Many Requests
{
"success": false,
"error": "Rate limit exceeded",
"retryAfter": 60
}
