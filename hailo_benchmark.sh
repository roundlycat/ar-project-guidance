#!/bin/bash

# Hailo 8L - Neural Processing Unit Baseline Test
# This script downloads a pre-compiled official YOLOv8 structure and forcefully 
# pumps it through the PCIe lane directly into your Hailo-8L to verify exactly
# how many frames per second the TPU can push safely!

echo "=============================================="
echo "⚡ IGNITING INFERNO HAILO-8L TPU PIPELINE ⚡"
echo "=============================================="

# 1. Download the pre-compiled YOLOv8 HEF (Hailo Executable Format) Model
echo "📥 1. Downloading Official YOLOv8s.hef model optimized for Hailo..."
wget -qO yolov8s.hef https://hailo-model-zoo.s3.eu-west-2.amazonaws.com/ModelZoo/Compiled/v2.11.0/hailo8l/yolov8s.hef

if [ -f "yolov8s.hef" ]; then
    echo "✅ Download successful!"
else
    echo "❌ Download failed. Check internet connection on Inferno."
    exit 1
fi

# 2. Probe the Hardware configuration
echo "🔍 2. Probing PCIe AI Co-processor..."
hailortcli fw-control identify

echo "----------------------------------------------"
echo "🔥 3. RUNNING INFERENCE BENCHMARK..."
echo "Pumping dummy video frames into the NPU at maximum bandwidth."
echo "(This verifies the hardware, cooling, and latency ceilings natively)"
echo "----------------------------------------------"

# 3. Execute the CLI Benchmark natively across the TPU
hailortcli benchmark yolov8s.hef

echo "=============================================="
echo "🏁 TEST COMPLETE"
echo "Look at the 'FPS' metric above! That is how many images per second"
echo "the system can recognize locally exactly vs Gemini's 8-second delay!"
echo "=============================================="
