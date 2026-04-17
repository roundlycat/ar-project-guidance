let videoStream = null;
let currentDeviceIndex = 0;
let videoDevices = [];

const videoElement = document.getElementById('macro-video');
const previewElement = document.getElementById('snap-preview');
const captureCanvas = document.getElementById('capture-canvas');
const shutterBtnContainer = document.getElementById('shutter-btn-container');
const actionButtons = document.getElementById('action-buttons');
const resultsDiv = document.getElementById('analysis-results');
const analyzeBtn = document.getElementById('analyze-btn');
const saveBtn = document.getElementById('save-local-btn');

let capturedBase64 = null;

async function startMacroCamera() {
    try {
        if (videoStream) {
            videoStream.getTracks().forEach(t => t.stop());
        }
        
        let constraints = { video: { facingMode: { ideal: "environment" } }, audio: false };

        if (videoDevices.length > 0) {
            constraints = { video: { deviceId: { exact: videoDevices[currentDeviceIndex].deviceId } }, audio: false };
        }

        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        videoElement.srcObject = videoStream;

        if (videoDevices.length === 0) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            videoDevices = devices.filter(device => device.kind === 'videoinput');
        }

    } catch (e) {
        console.error("Camera access failed", e);
        resultsDiv.style.display = 'block';
        resultsDiv.style.borderColor = '#ff5555';
        resultsDiv.style.color = '#ff8888';
        resultsDiv.innerHTML = "Could not access a camera.<br>Please ensure you granted camera permissions and are viewing over HTTPS.<br><br>" + e.message;
    }
}

async function flipMacroCamera() {
    if (videoDevices.length === 0) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devices.filter(device => device.kind === 'videoinput');
    }
    if (videoDevices.length > 1) {
        currentDeviceIndex = (currentDeviceIndex + 1) % videoDevices.length;
        await startMacroCamera();
    }
}

function takeMacroPhoto() {
    if (!videoStream) return;
    
    const track = videoStream.getVideoTracks()[0];
    const settings = track.getSettings();
    
    // Match canvas to full sensor resolution for maximum OCR quality
    captureCanvas.width = settings.width || videoElement.videoWidth;
    captureCanvas.height = settings.height || videoElement.videoHeight;
    
    const ctx = captureCanvas.getContext('2d');
    ctx.drawImage(videoElement, 0, 0, captureCanvas.width, captureCanvas.height);
    
    // Get high quality JPEG
    capturedBase64 = captureCanvas.toDataURL('image/jpeg', 0.95);
    
    // Show pristine preview
    previewElement.src = capturedBase64;
    previewElement.style.display = 'block';
    videoElement.style.display = 'none';
    
    // Swap UI to Analysis Action Buttons
    shutterBtnContainer.style.display = 'none';
    actionButtons.style.display = 'flex';
    resultsDiv.style.display = 'none';
    resultsDiv.textContent = '';
}

function resetScanner() {
    previewElement.style.display = 'none';
    videoElement.style.display = 'block';
    shutterBtnContainer.style.display = 'flex';
    actionButtons.style.display = 'none';
    resultsDiv.style.display = 'none';
    capturedBase64 = null;
}

function saveToDevice() {
    if (!capturedBase64) return;
    
    const aiText = resultsDiv.textContent;
    // Check if we have valid analysis result
    const hasText = (resultsDiv.style.display === 'block' && aiText && !aiText.startsWith("Scanning") && !aiText.startsWith("Error"));

    if (hasText) {
        // Embed text at the bottom of the image
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            
            const w = img.width;
            const h = img.height;
            
            // Dynamic font sizing based on image width to handle 4k vs 1080p robustly
            const fontSize = Math.max(30, Math.floor(w / 45)); 
            ctx.font = `${fontSize}px monospace`;
            const lineHeight = fontSize * 1.4;
            const padding = fontSize;
            
            // Wrap text
            const wrappedLines = [];
            const paragraphs = aiText.split('\n');
            for (let p of paragraphs) {
                if (p.trim() === '') {
                    wrappedLines.push('');
                    continue;
                }
                let words = p.split(' ');
                let currentLine = '';
                for (let word of words) {
                    const testLine = currentLine + word + ' ';
                    const metrics = ctx.measureText(testLine);
                    if (metrics.width > w - (padding * 2) && currentLine !== '') {
                        wrappedLines.push(currentLine);
                        currentLine = word + ' ';
                    } else {
                        currentLine = testLine;
                    }
                }
                wrappedLines.push(currentLine);
            }
            
            const textPanelHeight = (wrappedLines.length * lineHeight) + (padding * 2);
            
            canvas.width = w;
            canvas.height = h + textPanelHeight;
            
            // Draw original image
            ctx.drawImage(img, 0, 0);
            
            // Draw text panel background
            ctx.fillStyle = '#050505';
            ctx.fillRect(0, h, w, textPanelHeight);
            
            // Draw text
            ctx.fillStyle = '#a78bfa'; // Purple matching the UI analysis box
            ctx.textBaseline = 'top';
            ctx.font = `${fontSize}px monospace`;
            
            let y = h + padding;
            wrappedLines.forEach(line => {
                ctx.fillText(line, padding, y);
                y += lineHeight;
            });
            
            const finalBase64 = canvas.toDataURL('image/jpeg', 0.95);
            triggerDownload(finalBase64);
        };
        img.src = capturedBase64;
    } else {
        triggerDownload(capturedBase64);
    }
}

function triggerDownload(dataUrl) {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `Macro_Scan_${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}

async function analyzeMacroPhoto() {
    if (!capturedBase64) return;
    
    // This entirely bypasses the restrictive local http bridge (which iOS blocks),
    // and speaks directly to Google Gemini via HTTPS, making it perfect for iOS offline field-work!
    let geminiApiKey = localStorage.getItem('gemini_api_key');
    if (!geminiApiKey) {
        geminiApiKey = prompt("Please enter your Gemini API Key to run the IC OCR Analysis:");
        if (geminiApiKey) {
            localStorage.setItem('gemini_api_key', geminiApiKey);
        } else {
            return;
        }
    }

    resultsDiv.style.display = 'block';
    resultsDiv.style.borderColor = '#a78bfa';
    resultsDiv.style.color = '#ececec';
    resultsDiv.textContent = "Scanning silicon, reading IC markings, and analyzing component type...";
    
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyzing...";

    try {
        const base64Data = capturedBase64.split(',')[1];
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: "You are a Micro-Electronics Expert OCR analyzer system. Examine this close-up macro photograph of an electronic component or circuit board.\n1) Perform strict OCR to read all visible text, IC markings, batch numbers, or silk-screen labels.\n2) Identify the specific component/chip models if possible.\n3) Provide a brief (1-2 sentence) summary of what this component is widely used for or its common pinout/communication interface (I2C, SPI, etc).\n\nKeep the output highly concise, using plain text format (no bolding asterisks) to render cleanly on a mobile data screen." },
                        { inline_data: { mime_type: "image/jpeg", data: base64Data } }
                    ]
                }]
            })
        });

        if (!response.ok) throw new Error("Cloud Analysis Failed (Check API Key)");
        
        const data = await response.json();
        const aiText = data.candidates[0].content.parts[0].text;
        
        resultsDiv.textContent = aiText;
        
        // Unhide Push button
        const pushBtn = document.getElementById('push-registry-btn');
        if (pushBtn) pushBtn.style.display = 'block';
    } catch (e) {
        console.error("Analysis Error:", e);
        resultsDiv.style.borderColor = '#ff5555';
        resultsDiv.style.color = '#ff8888';
        resultsDiv.textContent = `Error performing analysis: ${e.message}`;
    } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "OCR & Analyze IC";
    }
}

// Start camera strictly when the DOM is loaded
window.addEventListener('load', startMacroCamera);


async function pushToRegistry() {
    if (!capturedBase64) return;
    const btn = document.getElementById('push-registry-btn');
    btn.textContent = "Pushing...";
    btn.disabled = true;

    const aiText = resultsDiv.textContent;
    try {
        // Convert Base64 directly into a real File Blob to satisfy Claude's API expectation
        const fetchResponse = await fetch(capturedBase64);
        const blob = await fetchResponse.blob();
        
        const formData = new FormData();
        formData.append("file", blob, `macro_${Date.now()}.jpg`);
        formData.append("gemini_text", aiText);

        const res = await fetch("/api/registry/intake", {
            method: "POST",
            body: formData // Secure multipart transmission directly matching Claude's logic
        });
        
        if (res.ok) {
            btn.textContent = "✅ Saved to Ontology DB!";
            btn.style.background = "rgba(46,204,113,0.2)";
            btn.style.color = "#2ecc71";
            btn.style.borderColor = "#2ecc71";
        } else {
            throw new Error("Server rejected payload");
        }
    } catch(e) {
        alert("Failed to push: " + e.message);
        btn.textContent = "☁️ Push to Project Registry";
        btn.disabled = false;
    }
}
