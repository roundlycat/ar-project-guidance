export class WireframeOverlay {
    constructor(containerSelector = '#wireframe-panel') {
        this.containerSelector = containerSelector;
        this.container = null;
        this.pollInterval = null;
        this.activeData = null;
        
        let proxyIp = localStorage.getItem('pi_ip') || '192.168.0.28';
        proxyIp = proxyIp.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        this.infernoApi = `http://${proxyIp}:20119`;
        
        this.offsetX = 0;
        this.offsetY = 0;
        this.scaleX = 1.0;
        this.scaleY = 1.0;
        this.initialized = false;
    }
    
    initDOM() {
        if (this.initialized) return;
        this.container = document.querySelector(this.containerSelector);
        if (!this.container) {
            console.error("WireframeOverlay: Container not found for selector", this.containerSelector);
            return;
        }

        // Make container relative for positioned children
        if (getComputedStyle(this.container).position === 'static') {
            this.container.style.position = 'relative';
        }

        this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        this.svg.id = 'wireframe-svg';
        this.svg.style.position = 'absolute';
        this.svg.style.top = '0';
        this.svg.style.left = '0';
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        this.svg.style.pointerEvents = 'none';
        this.svg.style.zIndex = '15'; // Bumped so it renders ABOVE the blurry UI panels
        this.svg.setAttribute('viewBox', '0 0 1000 1000');
        this.svg.setAttribute('preserveAspectRatio', 'none');
        this.container.appendChild(this.svg);

        this.infoPanel = document.createElement('div');
        this.infoPanel.setAttribute('style', 'display:none; position:absolute; top:10%; left:5%; width:90%; max-width:350px; background:rgba(20,25,40,0.85); backdrop-filter:blur(12px); border:1px solid rgba(0,229,255,0.4); border-radius:16px; padding:16px; color:#ececec; z-index:110; pointer-events:auto; box-shadow:0 10px 40px rgba(0,0,0,0.8);');
        this.container.appendChild(this.infoPanel);
        this.initialized = true;
    }
    
    start() {
        this.initDOM();
        if (!this.initialized) return;
        console.log("Wireframe overlay started.");
        this.refresh();
        this.isLocked = false;
        this.pollInterval = setInterval(() => this.refresh(), 8000);
    }
    
    toggleLock() {
        this.isLocked = !this.isLocked;
        if (this.isLocked) {
            if (this.pollInterval) clearInterval(this.pollInterval);
            console.log("Wireframe Locked - Polling Paused");
        } else {
            this.refresh(); // force immediate refresh
            this.pollInterval = setInterval(() => this.refresh(), 8000);
            console.log("Wireframe Unlocked - Polling Resumed");
        }
        return this.isLocked;
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.svg) this.svg.innerHTML = '';
        if (this.infoPanel) this.infoPanel.style.display = 'none';
        console.log("Wireframe overlay stopped.");
    }
    
    async refresh() {
        try {
            console.log("WireframeOverlay: Requesting analysis from Inferno...");
            let apiKey = localStorage.getItem('gemini_api_key');
            
            // Because they switched hosts, they need to input their key again
            if (!apiKey || apiKey.trim() === '') {
                apiKey = prompt("Please enter your Gemini API Key for AR Vision Analysis:");
                if (apiKey) {
                    localStorage.setItem('gemini_api_key', apiKey.trim());
                } else {
                    console.warn("Wireframe API Key aborted.");
                    return;
                }
            }
            
            const headers = { 'Content-Type': 'application/json' };
            headers['x-gemini-key'] = apiKey;
            
            let base64Image = null;
            const benchCam = document.getElementById('bench-cam-stream');
            const isBenchCamActive = benchCam && !benchCam.classList.contains('hidden');
            let sourceElement = isBenchCamActive ? benchCam : document.getElementById('camera-stream');
            
            if (sourceElement && (sourceElement.videoWidth > 0 || sourceElement.naturalWidth > 0)) {
                const MAX_WIDTH = 1024;
                let imgWidth = isBenchCamActive ? sourceElement.naturalWidth : sourceElement.videoWidth;
                let imgHeight = isBenchCamActive ? sourceElement.naturalHeight : sourceElement.videoHeight;

                if (imgWidth > MAX_WIDTH) {
                    imgHeight = Math.floor(imgHeight * (MAX_WIDTH / imgWidth));
                    imgWidth = MAX_WIDTH;
                }

                const canvas = document.createElement('canvas');
                canvas.width = imgWidth;
                canvas.height = imgHeight;
                canvas.getContext('2d').drawImage(sourceElement, 0, 0, imgWidth, imgHeight);
                try {
                    base64Image = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
                } catch(e) { console.warn("Wireframe capture error (CORS?):", e); }
            }

            const res = await fetch(`${this.infernoApi}/api/camera/analyse`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(base64Image ? { image_base64: base64Image } : {})
            });
            
            if (!res.ok) throw new Error(`Analyse endpoint failed: ${res.status} ${res.statusText}`);
            
            const data = await res.json();
            this.activeData = data.components || [];
            this.render();
        } catch (e) {
            console.warn("WireframeOverlay refresh failed:", e);
        }
    }
    
    render() {
        if (!this.svg) return;
        this.svg.innerHTML = '';
        if (!this.activeData || this.activeData.length === 0) return;

        const benchCam = document.getElementById('bench-cam-stream');
        const videoS = document.getElementById('camera-stream');
        
        // Determine the actual active image footprint to synchronize the SVG coordinate space
        let srcW = 1920;
        let srcH = 1080;
        if (benchCam && !benchCam.classList.contains('hidden') && benchCam.naturalWidth) {
            srcW = benchCam.naturalWidth;
            srcH = benchCam.naturalHeight;
        } else if (videoS && videoS.videoWidth) {
            srcW = videoS.videoWidth;
            srcH = videoS.videoHeight;
        }
        
        // Set the SVG to precisely mimic the object-fit: contain scaling using native viewBox!
        this.svg.setAttribute('viewBox', `0 0 ${srcW} ${srcH}`);
        this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        this.svg.style.width = '100%';
        this.svg.style.height = '100%';
        
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <filter id="text-shadow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.9"/>
            </filter>
        `;
        this.svg.appendChild(defs);

        // Render Connections (Lines)
        this.activeData.forEach(comp => {
            if (comp.wiring && comp.wiring.length > 0) {
                const x1 = (comp.box.xmin + ((comp.box.xmax - comp.box.xmin) / 2)) * srcW;
                const y1 = (comp.box.ymin + ((comp.box.ymax - comp.box.ymin) / 2)) * srcH;
                
                comp.wiring.forEach(wire => {
                    let targetX = x1 + 100;
                    let targetY = y1 - 100;
                    const targetComp = this.activeData.find(c => wire.connected_to && (c.label.toLowerCase().includes(wire.connected_to.toLowerCase()) || wire.connected_to.toLowerCase().includes(c.label.toLowerCase())));
                    
                    if (targetComp) {
                        targetX = (targetComp.box.xmin + ((targetComp.box.xmax - targetComp.box.xmin) / 2)) * srcW;
                        targetY = (targetComp.box.ymin + ((targetComp.box.ymax - targetComp.box.ymin) / 2)) * srcH;
                    }
                    
                    let visualColor = wire.wire_color || '#ffeb3b';
                    const lowerColor = visualColor.toLowerCase();
                    if (lowerColor.includes('red') || lowerColor.includes('vcc') || lowerColor.includes('5v')) visualColor = '#ff5555';
                    else if (lowerColor.includes('black') || lowerColor.includes('gnd')) visualColor = '#555555';
                    else if (lowerColor.includes('green')) visualColor = '#50fa7b';
                    else if (lowerColor.includes('blue')) visualColor = '#8be9fd';
                    
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x1);
                    line.setAttribute('y1', y1);
                    line.setAttribute('x2', targetX);
                    line.setAttribute('y2', targetY);
                    line.setAttribute('stroke', visualColor);
                    line.setAttribute('stroke-width', '4');
                    line.setAttribute('opacity', '0.7');
                    line.setAttribute('stroke-dasharray', '8,8');
                    this.svg.appendChild(line);
                });
            }
        });
        
        // Render Components (AR Reticles)
        this.activeData.forEach(comp => {
            // Map Gemini 0.0-1.0 coords exactly to the native image sensor pixels
            const pixelX = comp.box.xmin * srcW;
            const pixelY = comp.box.ymin * srcH;
            const pixelW = (comp.box.xmax - comp.box.xmin) * srcW;
            const pixelH = (comp.box.ymax - comp.box.ymin) * srcH;

            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('style', 'pointer-events:auto; cursor:pointer;');
            g.onclick = () => this.showInfo(comp);

            const length = Math.max(16, Math.min(pixelW, pixelH) * 0.2); 
            const pathData = `
                M ${pixelX},${pixelY+length} L ${pixelX},${pixelY} L ${pixelX+length},${pixelY}
                M ${pixelX+pixelW-length},${pixelY} L ${pixelX+pixelW},${pixelY} L ${pixelX+pixelW},${pixelY+length}
                M ${pixelX+pixelW},${pixelY+pixelH-length} L ${pixelX+pixelW},${pixelY+pixelH} L ${pixelX+pixelW-length},${pixelY+pixelH}
                M ${pixelX+length},${pixelY+pixelH} L ${pixelX},${pixelY+pixelH} L ${pixelX},${pixelY+pixelH-length}
            `;
            
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathData);
            path.setAttribute('fill', 'transparent');
            path.setAttribute('stroke', '#00e5ff');
            path.setAttribute('stroke-width', '6'); /* Scale up thickness because coordinate space is massive natively */
            path.setAttribute('filter', 'drop-shadow(0px 0px 8px rgba(0,229,255,0.7))');
            g.appendChild(path);

            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', pixelX + 6);
            label.setAttribute('y', Math.max(24, pixelY - 12));
            label.setAttribute('fill', '#00e5ff');
            label.setAttribute('stroke', '#000000');
            label.setAttribute('stroke-width', '8px');
            label.setAttribute('paint-order', 'stroke fill');
            label.setAttribute('font-family', 'Outfit, sans-serif');
            label.setAttribute('font-size', '28px'); /* Increased font size for huge viewBox */
            label.setAttribute('font-weight', 'bold');
            label.setAttribute('filter', 'url(#text-shadow)');
            label.textContent = comp.label;
            g.appendChild(label);

            this.svg.appendChild(g);
        });
    }
    
    showInfo(comp) {
        let wiringHtm = '';
        if (comp.wiring && comp.wiring.length > 0) {
            wiringHtm = '<div style="margin-top:12px; font-size:0.9em;"><strong style="color:#a78bfa;">Wiring:</strong><ul style="margin:4px 0; padding-left:20px; color:#ccc;">';
            comp.wiring.forEach(w => {
                wiringHtm += `<li><span style="color:${w.wire_color || '#fff'}">■</span> ${w.pin} &rarr; ${w.connected_to}</li>`;
            });
            wiringHtm += '</ul></div>';
        }
        
        let closeBtnId = `close-wireframe-info-${Date.now()}`;
        this.infoPanel.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding-bottom:8px; margin-bottom:8px;">
                <h3 style="margin:0; color:#00e5ff; font-family:monospace; font-size:1.1em;">${comp.label}</h3>
                <button id="${closeBtnId}" style="background:none; border:none; color:#ececec; font-size:1.5em; cursor:pointer;">&times;</button>
            </div>
            <div style="font-size:0.85em; color:#a3a3a3; text-transform:uppercase; letter-spacing:1px; margin-bottom:8px;">${comp.type || 'Component'}</div>
            <div style="font-size:0.95em; line-height:1.4;">${comp.notes || 'No specific notes.'}</div>
            ${wiringHtm}
        `;
        this.infoPanel.style.display = 'block';
        
        // Attach dynamic un-bindable listener
        document.getElementById(closeBtnId).onclick = () => {
            this.infoPanel.style.display = 'none';
        };
    }
}
