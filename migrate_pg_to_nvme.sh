#!/bin/bash
# ==============================================================================
# SENSOR ECOLOGY: POSTGRESQL NVME MIGRATION SCRIPT
# Run this on the Inferno Pi to move the pgvector database to the 500GB NVMe.
# ==============================================================================

set -e

# Configuration
NVME_MOUNT="/mnt/nvme"
PG_DATA_DIR="$NVME_MOUNT/postgresql"
PG_VERSION=$(ls /etc/postgresql/ | sort -n | tail -1)
PG_CONF="/etc/postgresql/$PG_VERSION/main/postgresql.conf"

echo "============================================================"
echo " Starting PostgreSQL Migration to NVMe"
echo " Detected PG Version: $PG_VERSION"
echo " Target NVMe path: $PG_DATA_DIR"
echo "============================================================"

# Ensure the NVMe is mounted
if ! grep -qs "$NVME_MOUNT" /proc/mounts; then
    echo "ERROR: NVMe drive is not mounted at $NVME_MOUNT."
    echo "Please mount it first (e.g., sudo mount /dev/nvme0n1p1 $NVME_MOUNT)"
    exit 1
fi

echo "[1/5] Stopping PostgreSQL service..."
sudo systemctl stop postgresql

echo "[2/5] Syncing data to NVMe (this may take a moment)..."
sudo mkdir -p "$PG_DATA_DIR"
# Copy data preserving permissions
sudo rsync -av /var/lib/postgresql/ "$PG_DATA_DIR/"

echo "[3/5] Updating PostgreSQL configuration..."
# Backup the original conf
sudo cp "$PG_CONF" "${PG_CONF}.bak"

# Use sed to update the data_directory
sudo sed -i "s|data_directory = '/var/lib/postgresql/$PG_VERSION/main'|data_directory = '$PG_DATA_DIR/$PG_VERSION/main'|g" "$PG_CONF"

echo "[4/5] Fixing systemd boot race condition..."
# Ensure PostgreSQL waits for the NVMe drive to be fully mounted before starting
sudo mkdir -p /etc/systemd/system/postgresql.service.d
MOUNT_UNIT=$(systemd-escape -p --suffix=mount "$NVME_MOUNT")

echo "[Unit]
Requires=$MOUNT_UNIT
After=$MOUNT_UNIT" | sudo tee /etc/systemd/system/postgresql.service.d/nvme-dependency.conf > /dev/null

sudo systemctl daemon-reload

echo "[5/5] Starting PostgreSQL service..."
sudo systemctl start postgresql

echo "============================================================"
echo " Migration Complete!"
echo " Verifying status..."
sudo systemctl status postgresql --no-pager | head -n 10
echo "============================================================"
echo " If everything is running correctly, your database is now backed by the NVMe."
