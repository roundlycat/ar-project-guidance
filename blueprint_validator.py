import json

# --- 1. The Target Blueprint ---
# What you INTEND to build (e.g., loaded from your PostgreSQL database)
TARGET_PROJECT = {
    "project_name": "Sensor Ecology Haptic Node",
    "required_parts": [
        {"role": "microcontroller", "required_keyword": "ESP32", "reason": "Requires Bluetooth LE for faster haptic streaming"},
        {"role": "stepper_driver", "required_keyword": "ULN2003", "reason": "Drives the 5V stepper motor"},
        {"role": "actuator", "required_keyword": "28BYJ-48", "reason": "Physical haptic feedback output"}
    ]
}

# --- 2. The Gemini Vision Payload ---
# What the AR camera currently SEES on the physical desk
GEMINI_PAYLOAD = {
    "detected_objects": [
        # Uh oh! The user put down an ESP8266 instead of an ESP32
        {"label": "NodeMCU ESP8266 (ESP-12F)", "confidence": 0.95, "bbox": [10, 20, 100, 200]},
        {"label": "28BYJ-48 Stepper Motor", "confidence": 0.99, "bbox": [150, 40, 250, 140]},
        # Notice: The ULN2003 driver is missing from the desk entirely!
        
        # Extra clutter on the desk:
        {"label": "Generic Green LED", "confidence": 0.88, "bbox": [300, 300, 310, 310]}
    ]
}

# --- 3. The Validation Engine ---
def run_hardware_assertions(blueprint, vision_payload):
    print(f"⚙️ Validating Workbench against Blueprint: '{blueprint['project_name']}'...\n")
    
    detected = vision_payload["detected_objects"].copy()
    required = blueprint["required_parts"]
    
    validation_results = []
    
    # Check each required part against the desk
    for part in required:
        keyword = part["required_keyword"]
        found_match = False
        
        for index, obj in enumerate(detected):
            # Very basic text matching (In reality, Gemini might standardize this or you use semantic embeddings)
            if keyword.lower() in obj["label"].lower():
                found_match = True
                
                # It's a perfect match! Format it for the GREEN AR display
                validation_results.append({
                    "role": part["role"],
                    "status": "VALID",
                    "ar_box_style": "SOLID_GREEN",
                    "ar_label_text": f"✅ {obj['label']}",
                    "original_bbox": obj["bbox"]
                })
                # Remove from detected pool so we don't double count
                detected.pop(index) 
                break
                
        if not found_match:
            # We didn't find the exact keyword. Is there a completely wrong part sitting in that 'role'?
            wrong_part_found = False
            
            # Simple heuristic rule: if it's the microcontroller that is missing, 
            # look for any other microcontroller on the desk to blame.
            if part["role"] == "microcontroller":
                for index, obj in enumerate(detected):
                    if "esp" in obj["label"].lower() or "mcu" in obj["label"].lower() or "arduino" in obj["label"].lower():
                        # We found a cousin part! It's an ESP8266, not an ESP32.
                        validation_results.append({
                            "role": part["role"],
                            "status": "INCORRECT_PART",
                            "ar_box_style": "SOLID_RED",
                            "ar_label_text": f"❌ Error: Required {keyword}. Found {obj['label']}.",
                            "ar_subtext": f"Reason: {part['reason']}",
                            "original_bbox": obj["bbox"]
                        })
                        detected.pop(index)
                        wrong_part_found = True
                        break
            
            # If it wasn't a wrong part, it's just completely missing from the physical desk.
            if not wrong_part_found:
                validation_results.append({
                    "role": part["role"],
                    "status": "MISSING",
                    "ar_box_style": "DASHED_GHOST_WHITE",
                    "ar_label_text": f"❓ Missing component: {keyword} ({part['role']})",
                    "original_bbox": None # Tell the AR frontend frontend.js to float a 'ghost' box in an empty space
                })
    
    # Anything leftover on the desk that wasn't required? (Clutter/Distractions)
    for obj in detected:
         validation_results.append({
            "role": "unassigned",
            "status": "UNNECESSARY_CLUTTER",
            "ar_box_style": "DASHED_YELLOW",
            "ar_label_text": f"⚠️ Not needed for this build: {obj['label']}",
            "original_bbox": obj["bbox"]
        })
         
    return validation_results

# --- 4. Run and Output ---
if __name__ == "__main__":
    results = run_hardware_assertions(TARGET_PROJECT, GEMINI_PAYLOAD)
    print("🎨 --- AR FRONTEND PAYLOAD --- 🎨")
    print(json.dumps(results, indent=2))
