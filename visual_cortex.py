import cv2
import time
import math
from ultralytics import YOLO
import requests
import threading

# Semantic Tracking State
semantic_label = None

def fire_semantic_snap(crop):
    global semantic_label
    semantic_label = "Consulting The Brain..."
    
    success, buffer = cv2.imencode('.jpg', crop)
    if not success:
        semantic_label = "Crop Error"
        return
        
    files = {"file": ("crop.jpg", buffer.tobytes(), "image/jpeg")}
    try:
        url = "http://127.0.0.1:8000/api/registry/identify"
        r = requests.post(url, files=files, timeout=20)
        
        if r.status_code == 200:
            data = r.json()
            if data.get("status") == "success":
                semantic_label = f"MATCH: {data['match']['label']}"
            else:
                semantic_label = "Unregistered Part"
        else:
            semantic_label = f"API Error {r.status_code}"
    except Exception as e:
        semantic_label = "Brain Offline"
        print(f"API Request Failed: {e}")

def fire_bench_snapshot(full_frame):
    success, buffer = cv2.imencode('.jpg', full_frame)
    if not success:
        print("Failed to encode bench snapshot.")
        return
        
    url = "http://127.0.0.1:8000/api/registry/snapshot"
    files = {"file": ("bench_snap.jpg", buffer.tobytes(), "image/jpeg")}
    try:
        r = requests.post(url, files=files, timeout=10)
        if r.status_code == 200:
            print("Successfully deposited bench snapshot to Sensor Ecology DB!")
        else:
            print(f"Snapshot deposit failed. API Response: {r.status_code}")
    except Exception as e:
        print(f"Snapshot upload failed (Backend offline?): {e}")

# Try to load Windows XInput for Xbox Controller vibration
try:
    import XInput
    state = XInput.get_connected()
    controller_connected = False
    controller_id = 0
    if state:
        for i in range(4):
            if state[i]:
                controller_id = i
                controller_connected = True
                break
                
    if controller_connected:
        print(f"Xbox Controller connected on slot {controller_id}!")
    else:
        print("No Xbox Controller found. Continuing without haptics.")
except ImportError:
    print("XInput-Python not installed. Run 'pip install XInput-Python' for haptics.")
    controller_connected = False
    controller_id = 0
    XInput = None

def set_haptics(pan_x, confidence):
    """
    Translates visual telemetry into embodied haptic signals.
    pan_x: 0.0 (left side of frame) to 1.0 (right side of frame)
    confidence: 0.0 (uncertain) to 1.0 (absolute lock)
    """
    if not controller_connected or not XInput:
        return

    # Grammar of Uncertainty:
    # Low confidence = heavy, jagged, jarring rumble (we use the left motor for deep rumbling)
    # High confidence = smooth, light purr (we use the right motor for high-frequency hum)
    
    intensity_scale = 1.0 - confidence 
    
    # Stereo panning based on object's position on screen
    left_bias = 1.0 - pan_x
    right_bias = pan_x
    
    # The XInput API allows motor speeds from 0 to 65535
    if confidence > 0.7:
        # Smooth purr (Object Locked)
        base_power = 12000
        left_power = int(base_power * left_bias * 0.3)
        right_power = int(base_power * right_bias * 1.5) # Emphasize high-freq motor
    else:
        # Dissonant, jarring rumble (Searching/Occluded/Uncertain)
        # Power increases as confidence drops
        base_power = 25000 + (intensity_scale * 30000)
        left_power = int(base_power * left_bias * 1.5) # Emphasize heavy motor
        right_power = int(base_power * right_bias * 0.2)
        
    # Clamp bounds to avoid overflow
    left_power = min(max(int(left_power), 0), 65535)
    right_power = min(max(int(right_power), 0), 65535)
    
    # Fire the actuators
    XInput.set_vibration(controller_id, left_power, right_power)

def main():
    global semantic_label
    print("Loading Edge Brain (YOLOv8-nano)...")
    model = YOLO("yolov8n.pt") # .pt will automatically download if missing
    
    print("Opening Optic Nerve (Camo Cam 1)...")
    cap = cv2.VideoCapture(1)
    
    # Request high resolution streaming 
    # (OpenCV will resize this as needed, but the visual UI benefits from crisp 1080p)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    
    print("=== Visual Cortex Online ===")
    print("Wave objects in front of the lens. Feel the coordinates in your hands.")
    print("Press 'q' in the video window to quit.")
    
    try:
        while True:
            ret, frame = cap.read()
            if not ret:
                print("Failed to grab physical frame. Feed ended.")
                break
                
            # Smash everything into a 640 grid for lightning-fast inference
            results = model.predict(frame, imgsz=640, verbose=False)
            
            best_confidence = 0
            best_box = None
            
            h, w, _ = frame.shape
            frame_area = h * w
            
            # Scan for the most dominant object (the one with the highest confidence)
            for r in results:
                boxes = r.boxes
                for box in boxes:
                    # Ignore massive bounding boxes (like the entire mat or desk)
                    bx1, by1, bx2, by2 = box.xyxy[0].cpu().numpy()
                    box_area = (bx2 - bx1) * (by2 - by1)
                    if box_area > frame_area * 0.4:  # If it takes up > 40% of screen, skip it
                        continue
                        
                    conf = float(box.conf[0])
                    if conf > best_confidence:
                        best_confidence = conf
                        best_box = box

            if best_box is not None:
                # Extract coordinates and class name
                x1, y1, x2, y2 = best_box.xyxy[0].cpu().numpy()
                center_x = (x1 + x2) / 2
                center_y = (y1 + y2) / 2
                cls_name = model.names[int(best_box.cls[0])]
                
                # Normalize X coordinate (0 to 1) for the haptic stereo field
                pan_x = center_x / w
                
                # Dispatch the Embodied Reflex!
                set_haptics(pan_x, best_confidence)
                
                # Draw the AR visualization
                # Color morphs from RED (uncertain) to GREEN (locked)
                color = (0, int(255 * best_confidence), int(255 * (1 - best_confidence))) 
                cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
                
                # Draw center crosshair
                cv2.drawMarker(frame, (int(center_x), int(center_y)), (0, 200, 255), 
                               markerType=cv2.MARKER_CROSS, markerSize=15, thickness=2)
                               
                if semantic_label:
                    # Clean up database text: strip newlines so OpenCV doesn't render them as '?'
                    clean_label = semantic_label.replace('\n', ' ').replace('\r', '')
                    words = clean_label.split(" ")
                    lines = []
                    current = ""
                    for word in words:
                        if len(current) + len(word) > 55:
                            lines.append(current)
                            current = word + " "
                        else:
                            current += word + " "
                    if current: lines.append(current)
                        
                    for i, text_line in enumerate(lines):
                        offset = max(y1-20, 50) - ((len(lines) - i) * 40)
                        cv2.putText(frame, text_line.strip(), (int(x1), int(offset)), 
                                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 255), 3)
                                
                cv2.putText(frame, f"YOLO: {cls_name} ({best_confidence:.2f})", (int(x1), int(y1)-10), 
                            cv2.FONT_HERSHEY_SIMPLEX, 1.0, color, 2)
            else:
                # Scene is empty -> Silence the haptics
                if controller_connected and XInput:
                    XInput.set_vibration(controller_id, 0, 0)
            
            # Render the Viewport (scaled up to 720p for better legibility)
            display_frame = cv2.resize(frame, (1280, 720))
            cv2.imshow("Visual Cortex - Fast AR Track (Camo)", display_frame)
            
            # Check for quit signal or SNAP signal
            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
            elif key == ord(' '):
                if best_box is not None:
                    print("- SNAP! Querying Semantic Brain...")
                    bx1, by1, bx2, by2 = map(int, best_box.xyxy[0].cpu().numpy())
                    # clamp bounds
                    by1, by2 = max(0, by1), min(h, by2)
                    bx1, bx2 = max(0, bx1), min(w, bx2)
                    if by2 > by1 and bx2 > bx1:
                        crop = frame[by1:by2, bx1:bx2].copy()
                        threading.Thread(target=fire_semantic_snap, args=(crop,)).start()
                else:
                    semantic_label = None # Clear if spaced on empty mat
            elif key == ord('b'):
                print("- RECORDING BENCH SNAPSHOT: Sending full frame to Ecology Engine...")
                # Dispatch full frame (copy so the thread has its own untouched matrix)
                threading.Thread(target=fire_bench_snapshot, args=(frame.copy(),)).start()

                
    finally:
        print("Shutting down cortex...")
        cap.release()
        cv2.destroyAllWindows()
        # Ensure motors turn off when script crashes or exits
        if controller_connected and XInput:
            XInput.set_vibration(controller_id, 0, 0)
            
if __name__ == "__main__":
    main()
