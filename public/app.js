document.addEventListener('DOMContentLoaded', () => {
    initCamera();
    startSensorSimulation();
});

const videoElement = document.getElementById('camera-stream');
const errorMsg = document.getElementById('error-msg');
const airflowVal = document.getElementById('airflow-val');
const tempVal = document.getElementById('temp-val');
const proxVal = document.getElementById('prox-val');
const logContainer = document.getElementById('semantic-log');
let currentStream = null;
let videoDevices = [];
let currentDeviceIndex = 0;
window.arSession = [];

async function initCamera() {
    try {
        let constraints = { video: { facingMode: 'environment' }, audio: false };

        // If we know the devices and are picking a specific one
        if (videoDevices.length > 0 && videoDevices[currentDeviceIndex].deviceId) {
            constraints = { video: { deviceId: { exact: videoDevices[currentDeviceIndex].deviceId } }, audio: false };
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentStream = stream;
        videoElement.srcObject = stream;
        errorMsg.classList.add('hidden');

        // Populate devices list if empty (now that we have permission)
        if (videoDevices.length === 0) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            videoDevices = devices.filter(device => device.kind === 'videoinput');

            // Find which index we are currently using
            const activeTrack = stream.getVideoTracks()[0];
            const activeIndex = videoDevices.findIndex(d => d.label === activeTrack.label);
            if (activeIndex !== -1) {
                currentDeviceIndex = activeIndex;
            }
        }

        log(`Camera active: ${stream.getVideoTracks()[0].label || 'Default'}`);
    } catch (error) {
        console.error('Error accessing the camera:', error);
        log(`Camera Error: ${error.message}`);

        // Fallback for laptops that refuse 'environment'
        if (error.name === 'OverconstrainedError' || error.name === 'NotAllowedError' || error.name === 'NotFoundError') {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
                currentStream = stream;
                videoElement.srcObject = stream;
                errorMsg.classList.add('hidden');
                log(`Fallback Camera active: ${stream.getVideoTracks()[0].label || 'Default'}`);
            } catch (fallbackError) {
                log(`All camera attempts failed.`);
            }
        }
    }
}

// Button toggler for rotating through available cameras
document.getElementById('camera-toggle').addEventListener('click', async () => {
    log("Switching camera...");
    if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
    }

    // Refresh device list just in case an external webcam was plugged in
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices = devices.filter(device => device.kind === 'videoinput');

    if (videoDevices.length > 0) {
        currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
    }

    initCamera();
});

// Global config - Dynamically load IP from localStorage to survive DHCP changes
let rawPiIp = localStorage.getItem('pi_ip') || '192.168.0.28';
// Fix double-port or rogue paths bug if a full URL is accidentally pasted in the config
let savedPiIp = rawPiIp.replace(/^https?:\/\//, '').split('/')[0].split(':')[0]; 

// Pipe telemetry fetching through our own secure HTTPS proxy gateway!
const API_URL = `/api/proxy/ecology?ip=${savedPiIp}`;
const BRIDGE_HTTP = window.location.origin;
const BRIDGE_WS = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

window.setPiIp = (newIp) => {
    localStorage.setItem('pi_ip', newIp);
    console.log(`Pi IP updated to ${newIp}. Reloading...`);
    window.location.reload();
};

window.promptPiIp = () => {
    const currentIp = localStorage.getItem('pi_ip') || '192.168.0.28';
    const newIp = prompt("Enter the Raspberry Pi's local IP address:", currentIp);
    if (newIp && newIp.trim() !== '' && newIp !== currentIp) {
        window.setPiIp(newIp.trim());
    }
};

// Live device states from WebSockets
let deviceLiveStates = {};
let activeSockets = {};

// Cognitive Aid Llama 3.2 logic
let activeDiagnostics = {};
let diagnosticResults = {};

async function requestDiagnosticAid(deviceId, anomalies, currentState) {
    // Only fire off one request at a time
    if (activeDiagnostics[deviceId]) return;
    activeDiagnostics[deviceId] = 'loading';
    log(`Consulting Llama 3.2 for device ${deviceId}...`);

    try {
        const res = await fetch(`${BRIDGE_HTTP}/api/device/${deviceId}/diagnose`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ anomalies: anomalies, current_state: currentState })
        });
        if (res.ok) {
            const data = await res.json();
            diagnosticResults[deviceId] = data.diagnosis;
            activeDiagnostics[deviceId] = 'done';
        } else {
            activeDiagnostics[deviceId] = 'failed';
        }
    } catch (e) {
        console.warn("Llama 3.2 diagnose failed:", e);
        activeDiagnostics[deviceId] = 'failed';
    }
}

// Subscribe to a specific device via WebSocket Narrow View
function subscribeToDevice(deviceId) {
    if (activeSockets[deviceId]) return; // Already subscribed

    log(`Connecting to Narrow View for ${deviceId}...`);
    const ws = new WebSocket(`${BRIDGE_WS}/ws/device/${deviceId}`);

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            deviceLiveStates[deviceId] = data;
            // The renderer will pick this up automatically on the next frame loop
        } catch (e) {
            console.error("WS Parse error", e);
        }
    };

    ws.onerror = () => console.warn(`WS Error on ${deviceId}`);
    ws.onclose = () => {
        delete activeSockets[deviceId];
        // Reconnect logic could go here if needed
    };

    activeSockets[deviceId] = ws;
}

// Real-time sensor polling from the Pi 5 macroscopic dashboard
function startSensorSimulation() {
    // Poll every 2.5 seconds for fresh global data
    setInterval(async () => {
        try {
            const response = await fetch(API_URL);
            if (!response.ok) return;
            const data = await response.json();

            // 1. Airflow logic (map from active domains)
            const dimWarm = data.domain_latest?.find(d => d.domain === "dim_warm" || d.domain === "embodied_state");
            if (dimWarm && dimWarm.agent_temp_c !== undefined) {
                airflowVal.textContent = dimWarm.agent_temp_c.toFixed(1) + ' °C';
            }

            // 2. Temperament logic (map from embodied/idle state)
            const idle = data.domain_latest?.find(d => d.domain === "idle" || d.domain === "environmental_field");
            if (idle && idle.event_label) {
                tempVal.textContent = idle.event_label.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            }

            // 3. Proximity / Narrative logic
            if (data.latest_resonance) {
                proxVal.textContent = data.latest_resonance.label;
            } else {
                proxVal.textContent = "Calm";
            }

            // Toggle visual styling based on most recent event timestamp
            let mostRecentTs = 0;
            if (data.domain_latest && data.domain_latest.length > 0) {
                mostRecentTs = Math.max(...data.domain_latest.map(d => new Date(d.event_start).getTime()));
            }

            const isStale = (Date.now() - mostRecentTs) > 30000;

            if (!isStale) {
                airflowVal.classList.add('active');
                airflowVal.classList.remove('agitated');
                videoElement.classList.add('calm');
                videoElement.classList.remove('agitated');
            } else {
                airflowVal.classList.add('agitated');
                airflowVal.classList.remove('active');
                videoElement.classList.add('agitated');
                videoElement.classList.remove('calm');
            }

        } catch (e) {
            console.warn("Could not fetch from Pi API:", e);
        }
    }, 2500);
}

// User Actions
window.simulateData = () => {
    log("Ping sent to local sensor array...");
    document.querySelector('.bounce1').style.display = 'inline-block';

    setTimeout(() => {
        log("Sensor array response: Nominal. Airflow active.");
    }, 1500);
};

window.addToSession = (itemJsonBase64, btnElement) => {
    try {
        const itemStr = decodeURIComponent(itemJsonBase64);
        const item = JSON.parse(itemStr);
        
        if (!window.arSession.some(i => i.label === item.label)) {
            window.arSession.push({
                timestamp: new Date().toISOString(),
                ...item
            });
        }
        
        btnElement.textContent = "✓ Added to Session";
        btnElement.disabled = true;
        btnElement.style.backgroundColor = "rgba(0,255,100,0.1)";
        btnElement.style.color = "#88ffba";
        btnElement.style.border = "1px solid #88ffba";
        
        const exportBtn = document.getElementById('export-session-btn');
        if (exportBtn) {
            exportBtn.textContent = `Save Session (${window.arSession.length})`;
            exportBtn.disabled = false;
        }
        
        const clearBtn = document.getElementById('clear-session-btn');
        if (clearBtn) clearBtn.style.display = 'block';
        
        const askGuideBtn = document.getElementById('ask-guide-btn');
        if (askGuideBtn) {
            askGuideBtn.style.display = 'block';
            askGuideBtn.disabled = false;
        }
        
        // Push focus to fixed monitor observers
        if (window.triggerFocus) {
            window.triggerFocus(item.device_id, item.label);
        }
        
        log(`Added ${item.label} to active session.`);
    } catch (e) {
        console.error("Session add error:", e);
    }
};

window.autoRegisterDevice = async (encodedLabel, encodedNotes, btnElement) => {
    try {
        const displayLabel = decodeURIComponent(encodedLabel);
        const notes = decodeURIComponent(encodedNotes) + " (Auto-registered via Web AR + Gemini Vision)";
        
        btnElement.textContent = "Registering...";
        btnElement.style.opacity = "0.7";
        btnElement.disabled = true;

        const payload = {
            display_name: displayLabel,
            cv_labels: [displayLabel], // Feed Gemini's literal string straight into CV registry list
            device_type: "scanned-sensor",
            location: "workbench",
            notes: notes
        };

        const res = await fetch(`${BRIDGE_HTTP}/api/registry/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Registry API failure");
        const data = await res.json();
        
        btnElement.textContent = "✓ Successfully Enrolled!";
        btnElement.style.backgroundColor = "rgba(0,255,100,0.1)";
        btnElement.style.color = "#88ffba";
        btnElement.style.border = "1px solid #88ffba";
        
        log(`Permanent Ontology Update: Created registry entry for '${displayLabel}' (UUID: ${data.device_id})`);
        
    } catch (e) {
        console.error(e);
        btnElement.textContent = "Registration Failed";
        btnElement.style.borderColor = "#ff5555";
        btnElement.style.color = "#ff5555";
    }
};

window.clearSession = () => {
    window.arSession = [];
    window.lastGuideResponse = null;
    window.sessionCorrections = [];
    
    document.getElementById('export-session-btn').textContent = "Save Session (0)";
    document.getElementById('export-session-btn').disabled = true;
    
    document.getElementById('clear-session-btn').style.display = 'none';
    
    document.getElementById('ask-guide-btn').style.display = 'none';
    
    // reset visual buttons
    document.querySelectorAll('.action-btn.outline[data-item]').forEach(btn => {
        btn.textContent = "+ Select for Session";
        btn.disabled = false;
        btn.style.backgroundColor = "transparent";
        btn.style.color = "var(--text)";
        btn.style.border = "1px solid var(--border)";
    });
    
    log("Active session cleared.");
};

window.askGuide = async () => {
    if (window.arSession.length === 0) return;
    
    let geminiApiKey = localStorage.getItem('gemini_api_key');
    if (!geminiApiKey) {
        geminiApiKey = prompt("Please enter your Gemini API Key for AR Vision Analysis:");
        if (geminiApiKey) {
            localStorage.setItem('gemini_api_key', geminiApiKey);
        } else {
            return;
        }
    }
    
    const userPrompt = prompt("What do you want to know about these components? (e.g. 'How do I wire these together?')");
    if (!userPrompt) return;
    
    const askBtn = document.getElementById('ask-guide-btn');
    const originalText = askBtn.textContent;
    askBtn.textContent = "Consulting...";
    askBtn.disabled = true;
    
    document.getElementById('ai-guide-modal').style.display = 'flex';
    const contentEl = document.getElementById('ai-guide-content');
    contentEl.textContent = "Analyzing components and generating engineering guide...";
    
    try {
        const componentContext = window.arSession.map(c => `- ${c.label}: ${c.notes}`).join('\n');
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `You are an expert embedded systems engineer guiding a user in AR. 
The user has selected these components on their workbench:
${componentContext}

The user asks: "${userPrompt}"

Provide a concise, practical engineering answer (under 300 words). If they ask about wiring, provide exact pin-to-pin mapping if possible. Remove any complex markdown wrappers, use plain text and basic hyphenated lists for readability in a dark AR UI.`
                    }]
                }]
            })
        });

        if (!response.ok) throw new Error("API limits or key error. Check console.");
        
        const data = await response.json();
        let aiText = data.candidates[0].content.parts[0].text;
        
        window.lastGuideResponse = aiText;
        // Safe render: split on **bold** markers, build DOM nodes — no innerHTML injection risk
        contentEl.innerHTML = '';
        const segments = aiText.split(/\*\*(.*?)\*\*/g);
        segments.forEach((seg, i) => {
            if (i % 2 === 1) {
                const b = document.createElement('strong');
                b.textContent = seg;
                contentEl.appendChild(b);
            } else {
                seg.split('\n').forEach((line, li, arr) => {
                    contentEl.appendChild(document.createTextNode(line));
                    if (li < arr.length - 1) contentEl.appendChild(document.createElement('br'));
                });
            }
        });
        log("AI Guide response received.");
        
        // Auto-save the guide response to the knowledge base immediately
        // This is the most valuable data — confirmed components + wiring/purpose from expert AI
        fetch(`${BRIDGE_HTTP}/api/guide/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                question: userPrompt,
                answer: aiText,
                components: window.arSession.map(c => c.label),
                corrections: window.sessionCorrections || []
            })
        }).then(r => r.json()).then(d => {
            if (d.guide_id) log(`✓ Guide saved to knowledge base (${d.guide_id})`);
        }).catch(() => {});
        
        
    } catch (e) {
        console.error("Ask Guide Error:", e);
        contentEl.textContent = `Error: ${e.message}`;
    } finally {
        askBtn.textContent = originalText;
        askBtn.disabled = false;
    }
};

window.sessionCorrections = [];
// Persistent in-session label override map: { "Gemini Guess" -> "User Correction" }
window.correctionMap = {};

let activeCorrectionLabel = null;
let activeCorrectionEncoded = null;
let correctionDebounce = null;

window.correctLabel = (origLabelEncoded) => {
    activeCorrectionEncoded = origLabelEncoded;
    activeCorrectionLabel = decodeURIComponent(origLabelEncoded);
    
    document.getElementById('correction-title').textContent = `Correct: ${activeCorrectionLabel}`;
    const input = document.getElementById('correction-input');
    input.value = activeCorrectionLabel;
    document.getElementById('correction-suggestions').innerHTML = '';
    
    document.getElementById('correction-modal').style.display = 'flex';
    setTimeout(() => input.focus(), 50);
};

window.handleCorrectionInput = (e) => {
    if (e.key === 'Enter') {
        window.submitCorrection();
        return;
    }
    
    const q = e.target.value.trim();
    const suggestionsBox = document.getElementById('correction-suggestions');
    
    if (q.length < 2) {
        suggestionsBox.innerHTML = '';
        return;
    }
    
    if (correctionDebounce) clearTimeout(correctionDebounce);
    
    correctionDebounce = setTimeout(async () => {
        try {
            const res = await fetch(`${BRIDGE_HTTP}/api/registry/search?q=${encodeURIComponent(q)}`);
            if (!res.ok) return;
            const data = await res.json();
            
            if (data.results && data.results.length > 0) {
                suggestionsBox.innerHTML = data.results.map(r => `
                    <div style="padding: 8px 12px; background: rgba(255,235,59,0.1); border: 1px solid rgba(255,235,59,0.3); border-radius: 4px; cursor: pointer; color: #fff;" 
                         onclick="document.getElementById('correction-input').value = '${r.label}'; document.getElementById('correction-suggestions').innerHTML = ''; window.submitCorrection();">
                        ${r.label}
                    </div>
                `).join('');
            } else {
                suggestionsBox.innerHTML = '';
            }
        } catch (err) {
            console.error(err);
        }
    }, 300);
};

window.submitCorrection = () => {
    const corrected = document.getElementById('correction-input').value.trim();
    if (!corrected || corrected === activeCorrectionLabel) {
        document.getElementById('correction-modal').style.display = 'none';
        return;
    }

    const origLabelEncoded = activeCorrectionEncoded;
    const origLabel = activeCorrectionLabel;

    // 1. Persist to in-session correction map so ALL future scans remap this label
    window.correctionMap[origLabel] = corrected;
    window.sessionCorrections.push({
        original_label: origLabel,
        corrected_label: corrected,
        notes: "User autocomplete correction in AR"
    });

    // 2. Update the label span on the card
    const labelSpan = document.getElementById(`label-${origLabelEncoded}`);
    if (labelSpan) {
        labelSpan.textContent = corrected;
        labelSpan.style.color = '#ffeb3b';
        // Add a visible "✓ Corrected" badge next to the label
        const existingBadge = labelSpan.parentNode.querySelector('.correction-badge');
        if (!existingBadge) {
            const badge = document.createElement('span');
            badge.className = 'correction-badge';
            badge.textContent = ' ✓ Corrected';
            badge.style.cssText = 'font-size:0.7em; color:#88ffba; background:rgba(0,255,100,0.15); border:1px solid #88ffba; border-radius:4px; padding:1px 5px; margin-left:6px;';
            labelSpan.parentNode.appendChild(badge);
        }
        // Flash the card border green briefly
        const card = labelSpan.closest('[style*="border"]') || labelSpan.closest('div');
        if (card) {
            const oldBorder = card.style.border;
            card.style.border = '1px solid #88ffba';
            card.style.boxShadow = '0 0 10px rgba(100,255,150,0.3)';
            setTimeout(() => { card.style.border = oldBorder; card.style.boxShadow = ''; }, 1500);
        }
    }

    // 3. Update the 'Add to Session' button data payload and re-enable it
    const addBtn = document.getElementById(`add-btn-${origLabelEncoded}`);
    if (addBtn) {
        try {
            const oldData = JSON.parse(decodeURIComponent(addBtn.getAttribute('data-item')));
            oldData.label = corrected;
            addBtn.setAttribute('data-item', encodeURIComponent(JSON.stringify(oldData)));
            // Re-enable so they can add the corrected item to session
            if (addBtn.disabled && addBtn.textContent.includes('Added')) {
                // Already in session — update the session record instead
                const existingIndex = window.arSession.findIndex(i => i.label === origLabel);
                if (existingIndex !== -1) window.arSession[existingIndex].label = corrected;
            }
        } catch(e) {}
    }

    // 4. Update if already in the active session
    const existingIndex = window.arSession.findIndex(i => i.label === origLabel);
    if (existingIndex !== -1) {
        window.arSession[existingIndex].label = corrected;
        log(`Updated active session item to '${corrected}'`);
    } else {
        log(`Marked '${origLabel}' to be corrected to '${corrected}'`);
    }
    
    document.getElementById('correction-modal').style.display = 'none';

    // 5. Auto-persist the correction to the DB as a CV training record
    const payload = {
        display_name: corrected,
        cv_labels: [origLabel, corrected],
        device_type: "cv-correction",
        notes: `CV training: Gemini guessed '${origLabel}', user corrected to '${corrected}'`
    };
    fetch(`${BRIDGE_HTTP}/api/registry/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(r => r.json()).then(d => {
        if (d.device_id) {
            log(`✓ Correction saved to registry: '${corrected}' (${d.device_id})`);
            // Show a small toast at the top of the log
            const toast = document.createElement('div');
            toast.style.cssText = 'position:fixed;top:16px;right:16px;background:rgba(0,200,100,0.9);color:#000;padding:8px 16px;border-radius:8px;font-size:0.85em;z-index:9999;font-weight:600;';
            toast.textContent = `✓ "${corrected}" saved to registry`;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), 3000);
        }
    }).catch(e => {
        console.warn('Could not auto-persist correction:', e);
        log(`⚠ Correction saved locally only (DB unavailable)`);
    });
};

window.exportSession = async () => {
    if (window.arSession.length === 0) return;
    
    // Save the entire batch to postgres instead of a local download
    const exportBtn = document.getElementById('export-session-btn');
    const prevText = exportBtn.textContent;
    exportBtn.textContent = "Saving to Database...";
    exportBtn.disabled = true;

    try {
        const payload = { 
            components: window.arSession,
            guide_response: window.lastGuideResponse || null,
            corrections: window.sessionCorrections || []
        };
        const response = await fetch(`${BRIDGE_HTTP}/api/session/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error("Failed to post session");
        const data = await response.json();
        
        log(`Session permanently saved to Postgres DB (ID: ${data.session_id}) with ${window.arSession.length} components.`);
        
        // Clear session after successful save
        window.clearSession();
        
    } catch (e) {
        console.error("Export failure:", e);
        log("Failed to save session to DB.");
        exportBtn.textContent = prevText;
        exportBtn.disabled = false;
    }
};

window.triggerFocus = async (deviceId, label) => {
    try {
        await fetch(`${BRIDGE_HTTP}/api/session/focus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_id: deviceId || null,
                label: label || 'Unknown Node'
            })
        });
        log(`Pushed AR focus for '${label}' to macroscopic observer...`);
    } catch (e) {
        console.warn("Failed to push AR focus", e);
    }
};

let isGhostMode = false;
window.toggleGhostMode = () => {
    isGhostMode = !isGhostMode;
    if (isGhostMode) {
        document.body.classList.add('ghost-mode');
        log("Ghost Mode Enabled - UI transparency maximized");
    } else {
        document.body.classList.remove('ghost-mode');
        log("Ghost Mode Disabled - UI restored");
    }
};

window.openSearchModal = () => {
    document.getElementById('search-modal').style.display = 'flex';
    // Small delay to ensure display: flex has rendered before focusing
    setTimeout(() => document.getElementById('search-input').focus(), 50);
};

window.performSearch = async () => {
    const q = document.getElementById('search-input').value.trim();
    if (!q) return;

    const resultsContainer = document.getElementById('search-results');
    resultsContainer.innerHTML = `<div style="text-align: center; color: #aaa;">Searching archives...</div>`;

    try {
        const res = await fetch(`${BRIDGE_HTTP}/api/session/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) throw new Error("Search failed");
        
        const data = await res.json();
        
        if (!data.results || data.results.length === 0) {
            resultsContainer.innerHTML = `<div style="text-align: center; color: #ff8888;">No historical matches found for '${q}'.</div>`;
            return;
        }

        let html = '';
        data.results.forEach(record => {
            const d = new Date(record.timestamp).toLocaleString();
            
            // Format components
            let compTags = '';
            if (record.components && Array.isArray(record.components)) {
                compTags = record.components.map(c => `<span style="background: rgba(77, 184, 255, 0.2); border: 1px solid #4db8ff; color: #4db8ff; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-right: 4px; display: inline-block; margin-bottom: 4px;">${c.label || 'Unknown'}</span>`).join('');
            }
            
            // Highlight search term in guide response
            let guideResponse = record.guide_response || 'No AI guidance recorded.';
            if (q.length > 2) {
                // Escape regex specials just in case
                const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`(${safeQ})`, 'gi');
                guideResponse = guideResponse.replace(regex, '<span style="background: rgba(255, 235, 59, 0.4); border-radius: 2px; padding: 0 2px; color: #fff;">$1</span>');
            }

            html += `
                <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px;">
                    <div style="font-size: 0.8em; color: #a3a3a3; margin-bottom: 8px;">Record ID: ${record.id} • ${d}</div>
                    <div style="margin-bottom: 8px;">${compTags}</div>
                    <div style="font-size: 0.9em; line-height: 1.4; color: #ececec; white-space: pre-wrap; font-family: monospace;">${guideResponse}</div>
                </div>
            `;
        });
        
        resultsContainer.innerHTML = html;
        log(`Archive search returned ${data.results.length} results.`);
        
    } catch (e) {
        console.error(e);
        resultsContainer.innerHTML = `<div style="text-align: center; color: #ff8888;">Error retrieving archives.</div>`;
    }
};

let isBenchCamActive = false;
let benchCamInterval = null;

window.toggleBenchCam = () => {
    isBenchCamActive = !isBenchCamActive;
    const benchCamStream = document.getElementById('bench-cam-stream');

    if (isBenchCamActive) {
        benchCamStream.classList.remove('hidden');
        videoElement.classList.add('hidden');
        log("Switched to Fixed Overhead Bench Camera Feed (Pi Zero)");

        // Start polling the snap endpoint directly from Inferno API proxy
        const updateCam = async () => {
            if (!isBenchCamActive) return;
            try {
                // Route correctly to the fast api server on 9500
                const infernoHttp = "http://" + (localStorage.getItem('pi_ip') || '192.168.0.28') + ":9500";
                const res = await fetch(`${infernoHttp}/api/camera/bench-snap?t=${Date.now()}`);
                if (!res.ok) throw new Error("Bench cam temporarily unavailable");
                const blob = await res.blob();
                
                if (isBenchCamActive) {
                    const objectUrl = URL.createObjectURL(blob);
                    
                    // Revoke old URL before setting new one to avoid memory leaks
                    if (benchCamStream.src && benchCamStream.src.startsWith('blob:')) {
                        URL.revokeObjectURL(benchCamStream.src);
                    }
                    benchCamStream.src = objectUrl;
                    
                    // Proceed to next frame smoothly
                    // Proceed to next frame smoothly (2 FPS max to prevent spamming Pi Zero and Server logs)
                    benchCamInterval = setTimeout(updateCam, 500);
                }
            } catch (err) {
                // If it crashes or the bridge is offline, wait a little longer before retrying
                console.warn("Bench feed issue:", err);
                if (isBenchCamActive) {
                    benchCamInterval = setTimeout(updateCam, 2000); 
                }
            }
        };

        updateCam();
    } else {
        benchCamStream.classList.add('hidden');
        videoElement.classList.remove('hidden');
        log("Switched to Local Device Camera");

        if (benchCamInterval) {
            clearTimeout(benchCamInterval);
            benchCamInterval = null;
        }
        
        // Clean up last blob object explicitly to keep memory profile low
        if (benchCamStream.src && benchCamStream.src.startsWith('blob:')) {
            URL.revokeObjectURL(benchCamStream.src);
            benchCamStream.src = "";
        }
    }
};

let isScanRequestActive = false;

window.triggerSingleScan = async () => {
    if (isScanRequestActive) return;
    
    const btn = document.getElementById('scan-toggle-btn');
    btn.textContent = "Analyzing Scene...";
    btn.disabled = true;
    btn.style.opacity = "0.7";
    log("Manual scan initiated. Capturing environment...");
    
    await performSingleScan();
    
    btn.textContent = "Capture & Analyze Scene";
    btn.disabled = false;
    btn.style.opacity = "1.0";
};

const performSingleScan = async () => {
    isScanRequestActive = true;

    // Check for API Key
    let geminiApiKey = localStorage.getItem('gemini_api_key');
    if (!geminiApiKey) {
        geminiApiKey = prompt("Please enter your Gemini API Key for AR Vision Analysis:");
        if (geminiApiKey) {
            localStorage.setItem('gemini_api_key', geminiApiKey);
        } else {
            log("Error: Analysis cancelled (API Key required).");
            isScanRequestActive = false;
            return;
        }
    }

    // Capture Image from Video Stream
    let sourceElement = videoElement;
    if (isBenchCamActive) {
        sourceElement = document.getElementById('bench-cam-stream');
        if (!sourceElement || !sourceElement.src) {
            log("Error: Bench camera not active. Cannot capture image.");
            isScanRequestActive = false;
            return;
        }
    } else {
        if (!videoElement || !currentStream) {
            log("Error: Camera not active. Cannot capture image.");
            isScanRequestActive = false;
            return;
        }
    }

    const bounce1 = logContainer.querySelector('.bounce1');
    if (bounce1) bounce1.style.display = 'inline-block';

    try {
        // Resize canvas to max 1024px to prevent Gemini 400 Payload Too Large errors
        const MAX_WIDTH = 1024;
        let imgWidth = isBenchCamActive ? sourceElement.naturalWidth : sourceElement.videoWidth;
        let imgHeight = isBenchCamActive ? sourceElement.naturalHeight : sourceElement.videoHeight;

        // Fallbacks if metadata isn't ready
        if (!imgWidth) imgWidth = sourceElement.width || 640;
        if (!imgHeight) imgHeight = sourceElement.height || 480;

        if (imgWidth > MAX_WIDTH) {
            imgHeight = Math.floor(imgHeight * (MAX_WIDTH / imgWidth));
            imgWidth = MAX_WIDTH;
        }

        const canvas = document.createElement('canvas');
        canvas.width = imgWidth;
        canvas.height = imgHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(sourceElement, 0, 0, imgWidth, imgHeight);

        // Convert to base64, removing the data URL prefix
        let base64Image;
        try {
            base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        } catch (corsErr) {
            throw new Error("Cannot scan Bench Cam: CORS security blocked frame capture. Is your ESP32 CAM sending Access-Control-Allow-Origin headers?");
        }

        // Send to Gemini expecting JSON
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        {
                            text: `You are the Gemini Vision API for the Sensor Ecology system. Your task is Component Identification.
Focus on identifying ESP32 nodes, sensors, cameras, small breakout boards (e.g. BME688, SHT31, ICM IMUs), and wiring on the bench. Pay special attention to extremely small square or rectangular sensor modules even if they are slightly blurry.
Analyze the image and respond strictly in JSON format with no markdown formatting.
You must use exactly this schema:
{
  "detected": [
    {
      "label": "String name of component",
      "confidence": "Float between 0.0 and 1.0",
      "device_id": "Try to guess an ID like esp32-node-3 if clear, otherwise null",
      "notes": "Specific notes on state or wiring"
    }
  ],
  "unrecognized": [
    {
      "label": "Description of unknown part",
      "notes": "Visual details"
    }
  ],
  "scene_notes": "Overall summary of the bench state"
}` },
                        { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                    ]
                }]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (response.status === 429) {
                nextScanDelay = 30000; // Double the timeout to let quota recover
                throw new Error("API Limit Reached (Too Many Requests). Pausing 30s for quota reset...");
            }
            if (response.status === 400 || response.status === 403) {
                localStorage.removeItem('gemini_api_key'); // clear invalid key on 400 or 403
                throw new Error(`API Config Error: Please provide a valid API key. (Got ${response.status})`);
            }
            throw new Error(`API Error ${response.status}: ${errorText.substring(0, 100)}`);
        }

        const data = await response.json();

        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content.parts.length > 0) {
            let aiText = data.candidates[0].content.parts[0].text;

            // Clean up possible markdown wrappers
            aiText = aiText.replace(/```json/g, '').replace(/```/g, '').trim();

            try {
                const parsed = JSON.parse(aiText);

                if (!parsed.detected && !parsed.unrecognized) return;

                let cardsHtml = "";

                // Render Detected Components
                if (parsed.detected && parsed.detected.length > 0) {
                    // Apply session correction map — if user already corrected a label this session,
                    // remap it before rendering so corrections survive across scans
                    parsed.detected = parsed.detected.map(item => {
                        if (window.correctionMap && window.correctionMap[item.label]) {
                            item.notes = (item.notes || '') + ` [Auto-corrected from '${item.label}']`;
                            item.label = window.correctionMap[item.label];
                        }
                        return item;
                    });

                    // Process device lookups concurrently
                    const resolutions = await Promise.all(parsed.detected.map(async (item) => {
                        // Filter out low confidence junk like "books" or "glasses"
                        if (item.confidence < 0.40) return item;

                        const encodedLabel = encodeURIComponent(item.label);
                        try {
                            const res = await fetch(`${BRIDGE_HTTP}/api/registry/resolve?label=${encodedLabel}`);
                            if (res.ok) {
                                const registryData = await res.json();
                                item.device_id = registryData.device_id;
                                subscribeToDevice(item.device_id);
                            }
                        } catch (e) {
                            console.warn("Could not resolve registry for", item.label);
                        }
                        return item;
                    }));

                    resolutions.forEach(item => {
                        if (item.confidence < 0.40) return;

                        let confidenceColor = item.confidence > 0.8 ? '#4db8ff' : '#ffb74d';
                        let deviceLink = item.device_id ? `<span style="font-size: 0.7em; background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-family: monospace;">UUID: ${item.device_id}</span>` : '';

                        // Pull live stats if we are subscribed to this UUID
                        let liveStatsHtml = '';
                        let hasHardAnomaly = false;

                        // Look for distress terminology in Gemini's physical notes 
                        const searchNotes = (item.notes || '').toLowerCase() + (item.label || '').toLowerCase();
                        let hasStressFlag = searchNotes.includes('hot') || searchNotes.includes('stress') || searchNotes.includes('thermal') || searchNotes.includes('distress') || searchNotes.includes('critical');

                        if (item.device_id && deviceLiveStates[item.device_id]) {
                            const stats = deviceLiveStates[item.device_id];
                            const anomalies = stats.data._anomalies || [];

                            if (anomalies.length > 0) {
                                hasStressFlag = true;
                                hasHardAnomaly = true;
                                liveStatsHtml += `<div style="margin-top: 6px; padding: 4px; border-left: 2px solid #ff5555; background: rgba(255,0,0,0.1); font-size: 0.8em; line-height: 1.2;">`;
                                anomalies.forEach(an => {
                                    liveStatsHtml += `<div style="color: #ff8888;"><b>[${an.level.toUpperCase()}] ${an.metric}</b>: ${an.value} > ${an.threshold}</div>`;
                                });
                                liveStatsHtml += `</div>`;

                                // Auto-trigger the Llama 3.2 Cognitive Aid
                                requestDiagnosticAid(item.device_id, anomalies, stats.data);
                            } else {
                                // Just show raw telemetry values neatly
                                liveStatsHtml += `<div style="margin-top: 6px; padding: 4px; background: rgba(0,255,100,0.1); font-size: 0.8em; line-height: 1.2; border-radius: 4px; color: #88ffba;">`;
                                Object.keys(stats.data).forEach(k => {
                                    if (k !== '_anomalies' && k !== 'raw') {
                                        if (typeof stats.data[k] === 'object' && stats.data[k] !== null) {
                                            Object.keys(stats.data[k]).forEach(subK => {
                                                liveStatsHtml += `<div>${k}.${subK}: <span style="color: #fff;">${stats.data[k][subK]}</span></div>`;
                                            });
                                        } else {
                                            liveStatsHtml += `<div>${k}: <span style="color: #fff;">${stats.data[k]}</span></div>`;
                                        }
                                    }
                                });
                                liveStatsHtml += `</div>`;
                            }
                        }

                        let diagnosisHtml = '';
                        if (item.device_id) {
                            if (activeDiagnostics[item.device_id] === 'loading') {
                                diagnosisHtml = `<div style="margin-top: 6px; padding: 6px; background: rgba(255,255,255,0.05); font-size: 0.8em; border-left: 2px solid #a3a3a3; font-style: italic; color: #ccc;">Consulting Llama 3.2 for diagnosis...</div>`;
                            } else if (activeDiagnostics[item.device_id] === 'done' && diagnosticResults[item.device_id]) {
                                diagnosisHtml = `<div style="margin-top: 6px; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; border-left: 3px solid #ffb74d; font-size: 0.85em; max-height: 150px; overflow-y: auto;">
                                    <strong style="color: #ffb74d;">Llama 3.2 Cognitive Aid:</strong><br/>
                                    <div style="margin-top: 4px; line-height: 1.4; color: #ececec; white-space: pre-wrap;">${diagnosticResults[item.device_id]}</div>
                                </div>`;
                            }
                        }

                        const serializedItem = encodeURIComponent(JSON.stringify({
                            label: item.label,
                            confidence: item.confidence,
                            device_id: item.device_id,
                            notes: item.notes
                        }));
                        const sessionBtnHtml = `<button class="action-btn outline" id="add-btn-${encodeURIComponent(item.label)}" style="width: 100%; padding: 6px; font-size: 0.85em; margin-top: 8px; border-radius: 4px;" data-item="${serializedItem}" onclick="event.stopPropagation(); window.addToSession(this.getAttribute('data-item'), this)">+ Select for Session</button>`;

                        let autoRegisterHtml = '';
                        if (!item.device_id) {
                            autoRegisterHtml = `<button class="action-btn" style="width: 100%; padding: 6px; font-size: 0.85em; margin-top: 8px; border-radius: 4px; background: rgba(255,183,77,0.2); color: #ffb74d; border: 1px solid #ffb74d;" onclick="event.stopPropagation(); window.autoRegisterDevice('${encodeURIComponent(item.label)}', '${encodeURIComponent(item.notes || '')}', this)">[+] Save Part to Master Registry</button>`;
                        }

                        cardsHtml += `
                            <div class="ar-card" style="border-left: 3px solid ${confidenceColor}; cursor: pointer;" onclick="window.triggerFocus('${item.device_id || ''}', '${item.label.replace(/'/g, "\\'")}'); this.classList.toggle('expanded');">
                                <div style="display: flex; justify-content: space-between; align-items: flex-start;">
                                    <strong style="color: ${confidenceColor}; font-size: 1.05em;"><span id="label-${encodeURIComponent(item.label)}">${item.label}</span> <button onclick="event.stopPropagation(); window.correctLabel('${encodeURIComponent(item.label)}')" style="background: none; border: none; font-size: 0.8em; opacity: 0.6; cursor: pointer; color: white;">✏️</button></strong>
                                    ${deviceLink}
                                </div>
                                <div style="font-size: 0.8em; opacity: 0.8; margin-bottom: 4px;">Confidence: ${(item.confidence * 100).toFixed(0)}%</div>
                                <div class="card-details">
                                    <div style="font-size: 0.9em; line-height: 1.3;">${item.notes || ''}</div>
                                    ${liveStatsHtml}
                                    ${diagnosisHtml}
                                    ${hasStressFlag ? `<div style="margin-top: 6px; padding: 4px; background: rgba(255,0,0,0.2); color: #ff8888; font-size: 0.8em; font-weight: bold; border-radius: 4px;">&#9888; ${hasHardAnomaly ? 'Telemetry Anomaly Detected!' : 'Actionable Support Requested!'}</div>` : ''}
                                    ${sessionBtnHtml}
                                    ${autoRegisterHtml}
                                </div>
                            </div>
                        `;
                    });
                }

                // Render Unrecognized components as subtle warnings
                if (parsed.unrecognized && parsed.unrecognized.length > 0) {
                    parsed.unrecognized.forEach(item => {
                        let origLabel = encodeURIComponent(item.label);
                        cardsHtml += `
                            <div class="ar-card unrecognized" style="border-left: 3px solid #ff6b6b; cursor: pointer;" onclick="window.triggerFocus('', '${item.label.replace(/'/g, "\\'")}'); this.classList.toggle('expanded');">
                                <strong style="color: #ff6b6b; font-size: 1.0em;">Unknown: <span id="label-${origLabel}">${item.label}</span> <button onclick="event.stopPropagation(); window.correctLabel('${origLabel}')" style="background: none; border: none; font-size: 0.8em; opacity: 0.6; cursor: pointer; color: white;">✏️</button></strong>
                                <div class="card-details">
                                    <div style="font-size: 0.85em; opacity: 0.9;">${item.notes || ''}</div>
                                </div>
                            </div>
                        `;
                    });
                }

                let finalHtml = `<div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">${cardsHtml}</div>`;

                // Append scene notes to the bottom
                if (parsed.scene_notes) {
                    finalHtml += `<div style="margin-top: 8px; font-size: 0.8em; font-style: italic; opacity: 0.8; margin-left: 4px;">${parsed.scene_notes}</div>`;
                }

                // Only log if we actually rendered cards (in case everything was filtered out)
                if (cardsHtml.length > 0) {
                    log(finalHtml);
                }
            } catch (e) {
                console.warn("Could not parse JSON from Gemini:", aiText);
            }
        }

    } catch (err) {
        console.error("Vision Analysis Error:", err);
        log(`<span style="color: #ffaa55;">&#9888; Scan failed: ${err.message}</span>`);
    } finally {
        const bounce1 = logContainer.querySelector('.bounce1');
        if (bounce1) bounce1.style.display = 'none';
        isScanRequestActive = false;
    }
};

// Logging System
function log(message) {
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="time">${time}</span><p>${message}</p>`;

    // Insert before the loader
    const loader = logContainer.querySelector('.loader');
    if (loader) {
        logContainer.insertBefore(entry, loader);
    } else {
        logContainer.appendChild(entry);
    }

    // Auto-scroll
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Thermal Vision Overlay Controller
let isThermalMode = false;
let benchSocket = null;
let lastThermalFrameTime = 0;

window.toggleThermalMode = () => {
    isThermalMode = !isThermalMode;
    const btn = document.getElementById('thermal-toggle');
    const thermalCanvas = document.getElementById('thermal-overlay');
    
    if (isThermalMode) {
        log("Thermal Overlay Enabled - Scanning for spatial heat signatures...");
        btn.classList.add('active');
        btn.style.backgroundColor = "rgba(255, 60, 60, 0.4)";
        thermalCanvas.classList.remove('hidden');
        
        // Connect to bench socket if not connected
        if (!benchSocket || benchSocket.readyState !== WebSocket.OPEN) {
            connectBenchSocket();
        }
    } else {
        log("Thermal Overlay Disabled");
        btn.classList.remove('active');
        btn.style.backgroundColor = "";
        thermalCanvas.classList.add('hidden');
        
        const tctx = thermalCanvas.getContext('2d');
        tctx.clearRect(0, 0, thermalCanvas.width, thermalCanvas.height);
    }
};

function connectBenchSocket() {
    log("Connecting to Global Bridge Stream...");
    benchSocket = new WebSocket(`${BRIDGE_WS}/ws/bench`);
    
    benchSocket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            // Check if it's our new MLX90640 device
            if (isThermalMode && msg.device_id === 'mlx90640-thermal-1' && msg.data.frame) {
                // Throttle drawing if needed, but Pi Zero 2Hz is slow anyway
                renderThermal(msg.data.frame);
            }
        } catch (e) {
            console.error("Bench WS Parse error", e);
        }
    };
    
    benchSocket.onerror = () => console.warn("Global Bench connection error.");
    
    benchSocket.onclose = () => {
        benchSocket = null;
        if (isThermalMode) {
            log("Global Bridge Stream disconnected. Retrying...");
            setTimeout(connectBenchSocket, 3000); 
        }
    };
}

function renderThermal(frameData) {
    if (!frameData || frameData.length !== 768) return;
    
    const thermalCanvas = document.getElementById('thermal-overlay');
    const tctx = thermalCanvas.getContext('2d', { alpha: true });
    
    // MLX90640 layout
    const w = 32;
    const h = 24;
    
    const cw = thermalCanvas.clientWidth || window.innerWidth;
    const ch = thermalCanvas.clientHeight || window.innerHeight;
    
    // Ensure canvas dimensions match logical size for rendering
    if (thermalCanvas.width !== cw || thermalCanvas.height !== ch) {
        thermalCanvas.width = cw;
        thermalCanvas.height = ch;
    }
    
    // Normalize bounds to squeeze the most contrast out of the room temperature
    let minT = 20.0;
    let maxT = 60.0; 
    let dataMin = Math.min(...frameData);
    let dataMax = Math.max(...frameData);
    
    // Auto-ranging with floors
    let rangeMin = Math.max(dataMin - 2, 15);
    let rangeMax = Math.max(dataMax, 35);
    
    const imgData = tctx.createImageData(w, h);
    for (let i = 0; i < 768; i++) {
        let val = frameData[i];
        
        let norm = (val - rangeMin) / (rangeMax - rangeMin);
        norm = Math.max(0, Math.min(1, norm)); 
        
        // Inferno-esque gradient logic
        let r, g, b, alpha;
        
        if (norm < 0.2) {
            // Cold / Ambient - Mostly transparent cool blue
            r = 0; g = 0; b = 150 + (norm * 500);
            alpha = Math.floor(255 * (norm * 1.5));
        } else if (norm < 0.5) {
            // Warm - Deep red/purple
            r = Math.floor((norm - 0.2) * 850); 
            g = 0; 
            b = Math.floor(255 - ((norm - 0.2) * 850));
            alpha = Math.floor(255 * (norm * 1.8));
        } else if (norm < 0.8) {
            // Hot - Red into Orange
            r = 255; 
            g = Math.floor((norm - 0.5) * 850); 
            b = 0;
            alpha = 255;
        } else {
            // Critical - Yellow into White
            r = 255; 
            g = 255; 
            b = Math.floor((norm - 0.8) * 1275);
            alpha = 255;
        }
        
        imgData.data[i * 4] = r;
        imgData.data[i * 4 + 1] = g;
        imgData.data[i * 4 + 2] = b;
        imgData.data[i * 4 + 3] = alpha; 
    }
    
    // Use an offscreen canvas to allow the browser to interpolate (smooth) the pixels perfectly
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const octx = offscreen.getContext('2d');
    octx.putImageData(imgData, 0, 0);
    
    tctx.clearRect(0, 0, cw, ch);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    
    // The MLX90640 FOV is wide, stretch it fully over the frame
    tctx.drawImage(offscreen, 0, 0, cw, ch);
}

// -------------------------------------------------------------
// TEXT TO SPEECH (TTS) - Read out AI Guide
// -------------------------------------------------------------
let currentUtterance = null;
let isSpeaking = false;

window.stopTTS = () => {
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
    isSpeaking = false;
    const btn = document.getElementById('tts-btn');
    if (btn) btn.textContent = '🔊';
};

window.toggleTTS = () => {
    const aiText = window.lastGuideResponse;
    if (!aiText) return;

    if (isSpeaking) {
        window.stopTTS();
        return;
    }

    if ('speechSynthesis' in window) {
        // Stop any ongoing speech
        window.speechSynthesis.cancel();
        
        // Let's strip out asterisks and dashes from markdown so the voice flow is better
        let cleanText = aiText.replace(/[*_#`~>]/g, '');
        
        currentUtterance = new SpeechSynthesisUtterance(cleanText);
        
        // Optional: pick a nice voice if available
        const voices = window.speechSynthesis.getVoices();
        // Try to find a good English voice
        const preferredVoice = voices.find(v => v.name.includes('Google') || v.name.includes('Samantha') || v.lang.startsWith('en'));
        if (preferredVoice) currentUtterance.voice = preferredVoice;

        currentUtterance.rate = 1.0;
        currentUtterance.pitch = 1.0;

        currentUtterance.onend = () => {
            isSpeaking = false;
            const btn = document.getElementById('tts-btn');
            if (btn) btn.textContent = '🔊';
        };
        
        currentUtterance.onerror = (e) => {
            console.warn("TTS Error: ", e);
            isSpeaking = false;
            const btn = document.getElementById('tts-btn');
            if (btn) btn.textContent = '🔊';
        };

        window.speechSynthesis.speak(currentUtterance);
        isSpeaking = true;
        
        const btn = document.getElementById('tts-btn');
        if (btn) btn.textContent = '⏸️';
    } else {
        alert("Text-to-speech is not supported in this browser.");
    }
};

// -------------------------------------------------------------
// HARDWARE LIBRARY & LIFECYCLE PASSPORT
// -------------------------------------------------------------
window.openHardwareLibrary = async () => {
    document.getElementById('hw-library-modal').style.display = 'flex';
    const listContainer = document.getElementById('hw-library-list');
    listContainer.innerHTML = '<div style="text-align:center; color:#a3a3a3;">Loading registry components...</div>';
    
    try {
        const res = await fetch(`${BRIDGE_HTTP}/api/registry/list`);
        if (!res.ok) throw new Error("Could not load registry");
        const data = await res.json();
        const components = data.components || [];
        
        let html = '';
        components.forEach(comp => {
            // Encode safely for DOM passing
            const compLabel = comp.display_name || comp.label || 'Unknown';
            const compId = comp.id || comp.device_id || compLabel.toLowerCase().replace(/\s+/g, '-');
            const notesEncoded = encodeURIComponent(comp.notes || '');
            const idEncoded = encodeURIComponent(compId);
            const nameEncoded = encodeURIComponent(compLabel);
            const typeEncoded = encodeURIComponent(comp.device_type || 'Unknown');
            
            // Re-use our addToSession function internally by fabricating an item
            const fabricatedItem = encodeURIComponent(JSON.stringify({
                device_id: compId,
                label: compLabel,
                notes: comp.notes || 'Manually added from Registry'
            }));

            // Check if already in active session
            const inSession = window.arSession.some(i => i.label === compLabel);
            const btnText = inSession ? "✓ Added" : "+ Add to Session";
            const btnDisabled = inSession ? "disabled" : "";
            const btnStyle = inSession ? "background-color: rgba(0,255,100,0.1); color: #88ffba; border: 1px solid #88ffba;" : "border-color: #50fa7b; color: #50fa7b;";

            html += `
                <div style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); border-radius: 8px; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
                    <div style="flex: 1;">
                        <div style="font-weight: 600; font-size: 1.1em; color: #ececec; margin-bottom: 4px;">${compLabel}</div>
                        <div style="font-size: 0.8em; color: #a3a3a3; font-family: monospace;">ID: ${compId} | Type: ${comp.device_type || 'Unknown'}</div>
                        <div style="display: flex; gap: 8px; margin-top: 8px;">
                            <button class="action-btn outline" style="padding: 6px 12px; font-size: 0.85em; ${btnStyle}" ${btnDisabled} onclick="window.addToSession('${fabricatedItem}', this)">${btnText}</button>
                            <button class="action-btn outline" style="padding: 6px 12px; font-size: 0.85em; border-color: #ff79c6; color: #ff79c6;" onclick="window.openPassport('${idEncoded}', '${nameEncoded}', '${notesEncoded}')">Passport Details</button>
                        </div>
                    </div>
                </div>
            `;
        });
        
        listContainer.innerHTML = html;
        log(`Loaded ${components.length} components from Hardware Registry.`);
    } catch (e) {
        console.error("Registry load error:", e);
        listContainer.innerHTML = '<div style="text-align:center; color:#ff5555;">Failed to load registry from Bridge server.</div>';
    }
};

let currentPassportId = null;

window.openPassport = (idEncoded, nameEncoded, notesEncoded) => {
    currentPassportId = decodeURIComponent(idEncoded);
    const displayName = decodeURIComponent(nameEncoded);
    const notes = decodeURIComponent(notesEncoded);
    
    document.getElementById('passport-title').textContent = displayName;
    document.getElementById('passport-subtitle').textContent = `ID: ${currentPassportId}`;
    document.getElementById('passport-notes').value = notes || '';
    
    const saveBtn = document.getElementById('passport-save-btn');
    saveBtn.textContent = 'Update Registry';
    saveBtn.disabled = false;
    
    document.getElementById('hw-passport-modal').style.display = 'flex';
};

window.savePassportNotes = async () => {
    if (!currentPassportId) return;
    
    const saveBtn = document.getElementById('passport-save-btn');
    const newNotes = document.getElementById('passport-notes').value;
    const oldText = saveBtn.textContent;
    
    saveBtn.textContent = "Saving...";
    saveBtn.disabled = true;
    
    try {
        const res = await fetch(`${BRIDGE_HTTP}/api/registry/${currentPassportId}/notes`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ notes: newNotes })
        });
        
        if (!res.ok) throw new Error("Failed to save notes");
        
        log(`Updated lifecycle maintenance notes for ${currentPassportId}`);
        saveBtn.textContent = "Saved!";
        
        // Refresh the registry builder view behind the scenes if open
        if (document.getElementById('hw-library-modal').style.display === 'flex') {
            window.openHardwareLibrary();
        }
        
        setTimeout(() => {
            document.getElementById('hw-passport-modal').style.display = 'none';
        }, 800);
    } catch (e) {
        console.error("Save passport error:", e);
        saveBtn.textContent = "Error!";
        setTimeout(() => {
            saveBtn.textContent = oldText;
            saveBtn.disabled = false;
        }, 2000);
    }
};
