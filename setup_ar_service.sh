#!/bin/bash

# ar-project-guidance systemd setup script
# Run this script on the Inferno Pi to install the AR Guidance Server as a service

SERVICE_NAME="ar-guidance"
WORKING_DIR="$(pwd)"
USER="$(whoami)"

echo "Setting up $SERVICE_NAME service for user $USER at $WORKING_DIR"

# Ensure virtual environment exists
if [ ! -d "venv" ] && [ ! -d ".venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
fi

# Activate venv and install requirements
echo "Installing dependencies..."
source venv/bin/activate
pip install -r requirements.txt

# Generate the systemd service file
SERVICE_FILE="/tmp/$SERVICE_NAME.service"

cat << EOF > $SERVICE_FILE
[Unit]
Description=AR Project Guidance FastAPI Server
After=network.target

[Service]
User=$USER
WorkingDirectory=$WORKING_DIR
Environment="PATH=$WORKING_DIR/venv/bin"
# Ensure environment variables are loaded from .env if present
EnvironmentFile=-$WORKING_DIR/.env
ExecStart=$WORKING_DIR/venv/bin/uvicorn server:app --host 0.0.0.0 --port 9500
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo "Moving service file to /etc/systemd/system/ (requires sudo)..."
sudo mv $SERVICE_FILE /etc/systemd/system/

echo "Reloading systemd daemon..."
sudo systemctl daemon-reload

echo "Enabling and starting $SERVICE_NAME service..."
sudo systemctl enable $SERVICE_NAME
sudo systemctl restart $SERVICE_NAME

echo "Setup complete! You can view logs anytime using:"
echo "journalctl -u $SERVICE_NAME -f"
