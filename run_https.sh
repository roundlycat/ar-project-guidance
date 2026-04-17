#!/bin/bash
echo "=============================================="
echo "🔒 GENERATING LOCAL HTTPS CERTIFICATE 🔒"
echo "=============================================="
# Generate a self-signed cert valid for 1 year instantly without any interactive prompts
openssl req -x509 -newkey rsa:4096 -nodes -out cert.pem -keyout key.pem -days 365 -subj "/CN=192.168.0.25"

echo "✅ Certificate generated."
echo "🔥 Booting Uvicorn over Secure Socket Layer (HTTPS)..."

# Run Uvicorn utilizing the newly created keys
uvicorn server:app --host 0.0.0.0 --port 9500 --ssl-keyfile=key.pem --ssl-certfile=cert.pem
