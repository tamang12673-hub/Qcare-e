// status.js (module) — Check appointment status for QCare
// Place next to your status.html. Uses Firebase v9 modular SDK.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import {
  getFirestore, collection, query, where, orderBy, getDocs, Timestamp
} from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js';

// --- Firebase config (same project used in app.js) ---
const firebaseConfig = {
  apiKey: "AIzaSyBSFa641kAxS-VY0yegNCFvWtlVimWRngE",
  authDomain: "doctorclinic-e9037.firebaseapp.com",
  projectId: "doctorclinic-e9037",
  storageBucket: "doctorclinic-e9037.appspot.com",
  messagingSenderId: "764350181093",
  appId: "1:764350181093:web:fcf0241a39228aa531ae0c",
  measurementId: "G-JDM07CKSGK"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// DOM
const phoneInput = document.getElementById('phone');
const doctorSelect = document.getElementById('doctor-select');
const checkBtn = document.getElementById('check-status');
const statusMsg = document.getElementById('status-msg');

const resultEl = document.getElementById('result');
const resName = document.getElementById('res-name');
const resPosition = document.getElementById('res-position');
const resStatus = document.getElementById('res-status');

function setMsg(text, muted = true) {
  statusMsg.textContent = text || '';
  statusMsg.style.color = muted ? '' : '#c53030';
}

function showResult(show) {
  if (show) resultEl.classList.remove('hidden'); else resultEl.classList.add('hidden');
}

function fmtDate(value) {
  if (!value) return '';
  // Firestore Timestamp has toDate, else it may be JS Date
  if (value instanceof Timestamp) return value.toDate().toLocaleString();
  if (value && typeof value.toDate === 'function') return value.toDate().toLocaleString();
  if (value instanceof Date) return value.toLocaleString();
  // fallback if object has seconds
  if (value && typeof value.seconds === 'number') return new Date(value.seconds * 1000).toLocaleString();
  return String(value);
}

function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function checkStatus() {
  const phoneRaw = (phoneInput.value || '').replace(/\D/g, '').slice(0,10);
  const doctorId = (doctorSelect.value || '').trim();

  showResult(false);
  setMsg('');

  if (!/^\d{10}$/.test(phoneRaw)) {
    setMsg('Enter a valid 10 digit phone number.', false);
    return;
  }
  if (!doctorId) {
    setMsg('Select a doctor.', false);
    return;
  }

  setMsg('Checking queue...', true);
  checkBtn.disabled = true;

  try {
    const colRef = collection(db, 'doctors', doctorId, 'queue');
    const q = query(colRef, where('status', '==', 'pending'), orderBy('token'));
    const snap = await getDocs(q);

    const docs = [];
    snap.forEach(d => {
      const data = d.data();
      docs.push({
        id: d.id,
        phone: data.phone || '',
        name: data.name || '',
        token: (typeof data.token === 'number') ? data.token : null,
        createdAt: data.createdAt || null,
        status: data.status || ''
      });
    });

    if (docs.length === 0) {
      setMsg('No pending appointments for this doctor.', true);
      return;
    }

    const matches = docs.filter(d => d.phone === phoneRaw);
    if (matches.length === 0) {
      setMsg('No booking found for this phone with selected doctor.', true);
      return;
    }

    let myEntry = null;
    if (matches.some(m => m.token !== null)) {
      myEntry = matches.reduce((a,b) => ( (a.token||0) > (b.token||0) ? a : b ));
    } else {
      myEntry = matches.reduce((a,b) => {
        const ta = (a.createdAt && typeof a.createdAt.toDate === 'function') ? a.createdAt.toDate().getTime() : (a.createdAt && a.createdAt.seconds ? a.createdAt.createdAt*1000 : 0);
        const tb = (b.createdAt && typeof b.createdAt.toDate === 'function') ? b.createdAt.toDate().getTime() : (b.createdAt && b.createdAt.seconds ? b.createdAt.createdAt*1000 : 0);
        return (ta >= tb) ? a : b;
      });
    }

    let ahead = 0;
    if (myEntry.token !== null) {
      ahead = docs.filter(d => (d.token !== null) && d.token < myEntry.token).length;
    } else if (myEntry.createdAt) {
      const myTs = (myEntry.createdAt && typeof myEntry.createdAt.toDate === 'function') ? myEntry.createdAt.toDate().getTime() : (myEntry.createdAt && myEntry.createdAt.seconds ? myEntry.createdAt.seconds*1000 : 0);
      ahead = docs.filter(d => {
        const ts = (d.createdAt && typeof d.createdAt.toDate === 'function') ? d.createdAt.toDate().getTime() : (d.createdAt && d.createdAt.seconds ? d.createdAt.seconds*1000 : 0);
        return ts < myTs;
      }).length;
    } else {
      ahead = docs.findIndex(d => d.id === myEntry.id);
      if (ahead < 0) ahead = 0;
    }

    resName.textContent = `${escapeHtml(myEntry.name || 'Patient')} • ${escapeHtml(phoneRaw)}`;
    const tokenText = myEntry.token !== null ? `Token: ${myEntry.token}` : 'Token: (not assigned)';
    resPosition.textContent = `${tokenText} — Patients ahead: ${ahead}`;
    resStatus.textContent = `Status: ${escapeHtml(myEntry.status || 'pending')} • Booked: ${fmtDate(myEntry.createdAt)}`;
    showResult(true);
    setMsg('');
  } catch (err) {
    console.error('Status check failed', err);
    setMsg('Failed to check status: ' + (err.message || err), false);
  } finally {
    checkBtn.disabled = false;
  }
}

checkBtn.addEventListener('click', checkStatus);
phoneInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    checkStatus();
  }
});