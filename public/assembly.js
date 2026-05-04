let assemblySteps = [];

let curStep = 0;

export async function initAssemblyMode(activeData = []) {
  document.getElementById('assembly-mode-panel').classList.remove('hidden');
  
  // Wire up buttons //
  const btnNext = document.getElementById('btn-next');
  const btnBack = document.getElementById('btn-back');
  if (btnNext) btnNext.onclick = nextStep;
  if (btnBack) btnBack.onclick = prevStep;
  document.querySelectorAll('.mode-tab').forEach(b => {
    b.onclick = (e) => setModeHtml(e.target.textContent.toLowerCase(), e.target);
  });
  
  // Use environment IPs similar to how the rest of the app dynamically gets them
  let savedPiIp = localStorage.getItem('pi_ip') || '192.168.0.28';
  savedPiIp = savedPiIp.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

  const INFERNO_URL = window.location.origin;
  const BRIDGE_URL = window.location.origin;
  
  // Try mapping the live AR components against the Python Server's Database!
  let dbMatchedParts = [];
  try {
      // Connect to the local bridge (Ecology backend)
      const res = await fetch(`${BRIDGE_URL}/api/registry/list`);
      if (res.ok) {
          const db = await res.json();
          const labels = activeData.map(c => c.label);
          
          if (labels.length > 0) {
              const matchedHtml = [];
              for (let lbl of labels) {
                 const m = db.components.find(d => d.label.toLowerCase() === lbl.toLowerCase() || lbl.toLowerCase().includes(d.label.toLowerCase()));
                 if (m) {
                     matchedHtml.push(`<span class="session-part" style="color:var(--done)">${m.label} ✓</span>`);
                     dbMatchedParts.push(m.label);
                 } else {
                     matchedHtml.push(`<span class="session-part">${lbl}</span>`);
                     dbMatchedParts.push(lbl);
                 }
              }
              
              const bar = document.querySelector('.session-bar');
              if (bar && matchedHtml.length > 0) {
                 bar.innerHTML = `
                    <div class="session-dot"></div>
                    <span style="color:var(--text-dim)">parts detected:</span>
                    ${matchedHtml.join('<span class="session-sep">+</span>')}
                    <span class="session-sep">·</span>
                    <span style="color:var(--text-dim)">database linked</span>
                 `;
              }
          }
      }
  } catch(e) {
      console.warn("Could not sync with project registry", e);
  }
  
  if (dbMatchedParts.length === 0) {
      dbMatchedParts = ["D1 Mini", "BME280"]; // Fallback generic mock if nothing detected
  }
  
  // Show goal input in the session bar area
  const sessionBar = document.querySelector('.session-bar');
  const goalInput = document.createElement('div');
  goalInput.style.cssText = 'display: flex; gap: 8px; align-items: center; margin-top: 8px; width: 100%;';
  goalInput.innerHTML = `
    <input type="text" id="assembly-goal-input" class="assembly-goal-input" 
           placeholder="Goal: e.g., Build an I2C sensor node for temperature monitoring..."
           value="Connect these components logically for a sensor node.">
    <button class="nav-btn primary" style="white-space: nowrap; padding: 8px 16px;" 
            onclick="document.getElementById('assembly-goal-input').closest('div').style.display='none'; window.regenerateAssembly();">
      Generate
    </button>
  `;
  if (sessionBar) sessionBar.parentNode.insertBefore(goalInput, sessionBar.nextSibling);
  
  // Store parts globally for regeneration
  window._assemblyParts = dbMatchedParts;

  // Call AI generative step composer setup
  const goal = document.getElementById('assembly-goal-input')?.value || 'Connect these components logically for a sensor node.';
  try {
      const composeRes = await fetch(`${INFERNO_URL}/api/assembly/generate`, {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ components: dbMatchedParts, goal: goal })
      });
      if (composeRes.ok) {
          const generatedPayload = await composeRes.json();
          document.querySelector('.cards-row').innerHTML = generatedPayload.cards_html;
          assemblySteps = generatedPayload.steps;
      } else {
          console.error("Failed to generate dynamic assembly steps", await composeRes.text());
      }
  } catch(e) {
      console.warn("Could not compose dynamic steps, check API key", e);
  }
  
  applyStep(0);
}

// Re-generate assembly with updated goal
window.regenerateAssembly = async function() {
  const goal = document.getElementById('assembly-goal-input')?.value || 'Connect these components logically for a sensor node.';
  const parts = window._assemblyParts || ['D1 Mini', 'BME280'];
  
  document.querySelector('.cards-row').innerHTML = `
    <div style="padding: 24px; color: var(--text-dim); text-align: center; width: 100%; font-family: monospace;">
      <div class="loader" style="margin: 0 auto 12px auto; display: block;">
        <div class="bounce1"></div>
        <div class="bounce2"></div>
        <div class="bounce3"></div>
      </div>
      Re-generating wiring schema for: ${goal.substring(0, 60)}...
    </div>
  `;
  
  try {
    const composeRes = await fetch(`${window.location.origin}/api/assembly/generate`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ components: parts, goal: goal })
    });
    if (composeRes.ok) {
      const generatedPayload = await composeRes.json();
      document.querySelector('.cards-row').innerHTML = generatedPayload.cards_html;
      assemblySteps = generatedPayload.steps;
      curStep = 0;
      applyStep(0);
    }
  } catch(e) {
    console.warn("Regeneration failed", e);
  }
};

export function exitAssemblyMode() {
  document.getElementById('assembly-mode-panel').classList.add('hidden');
}

function applyStep(s) {
  const step = assemblySteps[s];

  // swatch
  const sw = document.getElementById('step-swatch');
  if (sw) {
      sw.style.background = step.color;
      sw.style.color = step.color;
      sw.style.boxShadow = `0 0 8px ${step.color}`;
  }

  // step text
  const stepNum = document.getElementById('step-num');
  const stepText = document.getElementById('step-text');
  const warnEl = document.getElementById('step-warn');
  
  if (stepNum) stepNum.textContent = step.num;
  if (stepText) stepText.innerHTML = step.text;
  if (warnEl) {
    if (step.warn) {
      warnEl.textContent = step.warn;
      warnEl.style.display = 'flex';
    } else {
      warnEl.style.display = 'none';
    }
  }

  // wires
  document.querySelectorAll('.wire-path').forEach(w => w.classList.remove('lit'));
  step.wires.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('lit'); void el.offsetWidth; el.classList.add('lit'); }
  });

  // pins
  document.querySelectorAll('.pin-row').forEach(p => p.classList.remove('lit'));
  step.pins.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('lit');
  });

  // progress dots
  for (let i = 0; i < assemblySteps.length; i++) {
    const dot = document.getElementById('dot'+i);
    const line = document.getElementById('line'+(i));
    if (!dot) continue;
    dot.classList.remove('active','done');
    if (i < s) { dot.classList.add('done'); dot.textContent = '✓'; }
    else if (i === s) { dot.classList.add('active'); dot.textContent = i+1; }
    else { dot.textContent = i+1; }
    if (line) line.classList.toggle('done', i < s);
  }

  // completion
  const isLast = s === assemblySteps.length - 1;
  const completePanel = document.getElementById('complete-panel');
  const stepPanel = document.getElementById('step-panel');
  const btnNext = document.getElementById('btn-next');
  const btnBack = document.getElementById('btn-back');

  if (completePanel) completePanel.classList.toggle('visible', isLast);
  if (stepPanel) stepPanel.style.display = isLast ? 'none' : 'flex';
  if (btnNext) {
      btnNext.textContent = isLast ? 'flash config ↗' : 'confirm & next →';
      btnNext.className = isLast ? 'nav-btn complete' : 'nav-btn primary';
  }
  if (btnBack) btnBack.style.opacity = s === 0 ? '0.3' : '1';
}

function nextStep() {
  if (curStep < assemblySteps.length - 1) { curStep++; applyStep(curStep); }
  else { flashConfig(); }
}
function prevStep() {
  if (curStep > 0) { curStep--; applyStep(curStep); }
}
window.goStep = function(s) {
  curStep = s; applyStep(curStep);
};

function setModeHtml(m, btn) {
  if (m === 'discovery') {
     exitAssemblyMode();
     if (typeof window.unlockWireframe === 'function') {
         window.unlockWireframe();
     }
  }
}

function flashConfig() {
  alert('Flashing firmware logic via native Android host bridging...');
}
