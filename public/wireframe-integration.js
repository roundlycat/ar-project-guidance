/**
 * wireframe-integration.js
 *
 * Shows how to drop WireframeOverlay into your existing AR app.
 * Add a container div to your AR app HTML, then call this.
 *
 * In your AR app HTML add a tab or panel like:
 *
 *   <div id="wireframe-panel" style="width:100%;height:480px;border-radius:8px;overflow:hidden;">
 *   </div>
 *
 * Then import and initialise:
 */

import { WireframeOverlay } from './wireframe.js?v=8';

let overlay = null;

window.initWireframe = function() {
  if (!overlay) {
    overlay = new WireframeOverlay('#wireframe-panel');
  }
  overlay.start();
  document.getElementById('wireframe-panel').classList.remove('hidden');
  document.getElementById('wireframe-lock-btn')?.classList.remove('hidden');
};

window.stopWireframe = function() {
  overlay?.stop();
  document.getElementById('wireframe-panel').classList.add('hidden');
  document.getElementById('wireframe-lock-btn')?.classList.add('hidden');
};

window.isWireframeActive = false;
window.toggleWireframe = function() {
  window.isWireframeActive = !window.isWireframeActive;
  if (window.isWireframeActive) {
    window.initWireframe();
  } else {
    window.stopWireframe();
  }
};

window.refreshWireframe = function() {
  overlay?.refresh();
};

window.toggleWireframeLock = function() {
  if (overlay) {
    const isLocked = overlay.toggleLock();
    const btn = document.getElementById('wireframe-lock-btn');
    if (btn) {
      if (isLocked) {
        btn.style.color = "#ff4081";
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-lock"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
        
        // Transition to assembly mode natively!
        if (typeof window.initAssemblyMode === 'function') {
           window.initAssemblyMode(overlay.activeData || []);
        }
      } else {
        btn.style.color = "white";
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-unlock"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>`;
      }
    }
  }
};

window.unlockWireframe = function() {
  if (overlay && overlay.isLocked) {
     window.toggleWireframeLock();
  }
};

// ── If you want the wireframe to respond to AR Guidance tab switching ─────────
// In your existing tab-switching logic, add:
//
//   case 'wireframe':
//     initWireframe();
//     break;
//
//   default:
//     stopWireframe();

// ── If you want to trigger analysis on Capture & Analyse button ────────────
// In your existing captureAndAnalyse() function, after your Gemini call,
// also call:
//   overlay?.refresh();
//
// This way a manual capture refreshes both the Gemini component analysis
// AND the wireframe overlay in one action.
