import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBNICl16L5yCBX21Qzn7JEblavF0CbPMkI",
  authDomain: "ar-guidance-4b333.firebaseapp.com",
  projectId: "ar-guidance-4b333",
  storageBucket: "ar-guidance-4b333.firebasestorage.app",
  messagingSenderId: "750444091510",
  appId: "1:750444091510:web:207d264f1efb8cf93ee757"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export function initAuth() {
  const authBtn = document.getElementById('auth-btn');
  if (!authBtn) return;

  // Monitor Authentication State
  onAuthStateChanged(auth, (user) => {
    if (user) {
      console.log("User is signed in:", user.displayName);
      // Change icon to signed-in state or profile picture
      authBtn.innerHTML = `
        <img src="${user.photoURL}" alt="Profile" style="width: 20px; height: 20px; border-radius: 50%;" title="Sign out (${user.displayName})">
      `;
      authBtn.classList.add('signed-in');
      authBtn.onclick = handleSignOut;
    } else {
      console.log("User is signed out.");
      // Revert to login icon
      authBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-user">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
          <circle cx="12" cy="7" r="4"></circle>
        </svg>
      `;
      authBtn.classList.remove('signed-in');
      authBtn.onclick = handleSignIn;
    }
  });
}

async function handleSignIn() {
  try {
    const result = await signInWithPopup(auth, provider);
    console.log("Successfully logged in:", result.user.displayName);
  } catch (error) {
    console.error("Error signing in:", error.message);
  }
}

async function handleSignOut() {
  try {
    await signOut(auth);
    console.log("Successfully logged out");
  } catch (error) {
    console.error("Error signing out:", error.message);
  }
}

// Automatically initialize if the button exists
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
});
