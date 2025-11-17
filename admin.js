// admin.js — improved Doctor admin panel (OTP sign-in, real-time queue, safe token allocation, soft-delete)
// Replaces the previous admin.js with better error handling, transaction-safe token allocation,
// soft-deletes instead of deleteDoc, recaptcha reset, and small UX improvements.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import {
  getAuth,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  onSnapshot,
  addDoc,
  updateDoc,
  query,
  where,
  orderBy,
  getDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js';

// --- Firebase config (same as your app) ---
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
const auth = getAuth(app);
const db = getFirestore(app);

// Map phone -> doctorId + display name (your mapping)
const DOCTOR_PHONE_MAP = {
  '9508053632': { id: 'ansari', name: 'Dr. Ansari (MBBS)' },
  '7409554950': { id: 'khan',   name: 'Dr. Khan (MBBS)' },
  '8210659628': { id: 'patel',  name: 'Dr. Patel (MBBS)' }
};

// UI refs
const phoneInput = document.getElementById('phone-input');
const sendOtpBtn = document.getElementById('send-otp');
const loginMsg = document.getElementById('login-msg');
const verifyBlock = document.getElementById('verify-block');
const otpInput = document.getElementById('otp-code');
const verifyBtn = document.getElementById('verify-otp');

const loginSection = document.getElementById('login-section');
const panelSection = document.getElementById('panel-section');
const doctorPhoneEl = document.getElementById('doctor-phone');
const doctorNameEl = document.getElementById('doctor-name');
const queueList = document.getElementById('queue-list');
const signOutBtn = document.getElementById('sign-out');
const markDoneBtn = document.getElementById('mark-done');
const downloadBtn = document.getElementById('download-list');

const addForm = document.getElementById('add-form');
const addName = document.getElementById('add-name');
const addPhone = document.getElementById('add-phone');
const addAge = document.getElementById('add-age');
const addSex = document.getElementById('add-sex');
const addCity = document.getElementById('add-city');
const holidayDate = document.getElementById('holiday-date');
const markHolidayBtn = document.getElementById('mark-holiday');

let currentDoctorId = null;
let unsubscribe = null;
let confirmationResult = null;
let recaptchaVerifier = null;

// Helpers
function setLoginMsg(text = '', isError = false) {
  loginMsg.textContent = text;
  loginMsg.style.color = isError ? '#c53030' : '';
}

function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatDate(ts) {
  if (!ts) return '';
  if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
  if (ts.seconds) return new Date(ts.seconds * 1000).toLocaleString();
  return String(ts);
}

// Recaptcha (invisible) init
function ensureRecaptcha() {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new RecaptchaVerifier('recaptcha-container', { size: 'invisible' }, auth);
  // render the widget (render returns a promise but we don't need the id here)
  recaptchaVerifier.render().catch((e) => console.warn('reCAPTCHA render failed:', e));
  return recaptchaVerifier;
}

function clearRecaptcha() {
  try {
    if (recaptchaVerifier && typeof recaptchaVerifier.clear === 'function') {
      recaptchaVerifier.clear();
    } else if (window.recaptchaVerifier && typeof window.recaptchaVerifier.clear === 'function') {
      window.recaptchaVerifier.clear();
    }
  } catch (e) {
    // ignore
  }
  recaptchaVerifier = null;
}

// OTP send
sendOtpBtn.addEventListener('click', async () => {
  setLoginMsg('');
  const phone = (phoneInput.value || '').trim();
  if (!/^[0-9]{10}$/.test(phone)) {
    setLoginMsg('Enter a valid 10-digit phone.', true);
    return;
  }
  if (!DOCTOR_PHONE_MAP[phone]) {
    setLoginMsg('This phone is not registered as a doctor.', true);
    return;
  }
  const fullPhone = '+91' + phone;
  sendOtpBtn.disabled = true;
  setLoginMsg('Sending OTP...');
  try {
    ensureRecaptcha();
    confirmationResult = await signInWithPhoneNumber(auth, fullPhone, recaptchaVerifier);
    setLoginMsg('OTP sent. Enter the code you received.');
    verifyBlock.classList.remove('hidden');
    otpInput.focus();
  } catch (err) {
    console.error('send OTP failed', err);
    setLoginMsg('Failed to send OTP: ' + (err.message || err), true);
    clearRecaptcha();
  } finally {
    sendOtpBtn.disabled = false;
  }
});

// OTP verify
verifyBtn.addEventListener('click', async () => {
  setLoginMsg('');
  const code = (otpInput.value || '').trim();
  if (!/^\d{4,6}$/.test(code)) {
    setLoginMsg('Enter a valid OTP code.', true);
    return;
  }
  if (!confirmationResult) {
    setLoginMsg('No OTP request found. Please request OTP again.', true);
    return;
  }
  verifyBtn.disabled = true;
  setLoginMsg('Verifying...');
  try {
    await confirmationResult.confirm(code);
    // onAuthStateChanged will fire and wire up the panel
    setLoginMsg('Verified.');
    verifyBlock.classList.add('hidden');
    otpInput.value = '';
    clearRecaptcha();
  } catch (err) {
    console.error('OTP verify failed', err);
    setLoginMsg('Verification failed: ' + (err.message || err), true);
  } finally {
    verifyBtn.disabled = false;
  }
});

// Auth state change: show/hide panel and subscribe to queue
onAuthStateChanged(auth, (user) => {
  if (user) {
    const phoneE164 = user.phoneNumber || '';
    const phone = phoneE164.replace(/^\+91/, '').replace(/\D/g, '');
    if (!DOCTOR_PHONE_MAP[phone]) {
      alert('This account is not allowed to access admin. Signing out.');
      signOut(auth).catch(() => {});
      return;
    }
    const meta = DOCTOR_PHONE_MAP[phone];
    currentDoctorId = meta.id;
    doctorPhoneEl.textContent = phone;
    doctorNameEl.textContent = meta.name;
    loginSection.classList.add('hidden');
    panelSection.classList.remove('hidden');
    loadQueue(currentDoctorId);
  } else {
    // signed out
    currentDoctorId = null;
    doctorPhoneEl.textContent = '';
    doctorNameEl.textContent = '';
    loginSection.classList.remove('hidden');
    panelSection.classList.add('hidden');
    setLoginMsg('');
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  }
});

// sign out button
signOutBtn.addEventListener('click', async () => {
  try {
    await signOut(auth);
  } catch (err) {
    console.warn('signOut error', err);
  }
});

// load queue in real-time (onSnapshot)
function loadQueue(doctorId) {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  const q = query(collection(db, 'doctors', doctorId, 'queue'), orderBy('token'), orderBy('createdAt'));
  unsubscribe = onSnapshot(q, (snap) => {
    queueList.innerHTML = '';
    if (snap.empty) {
      const li = document.createElement('li');
      li.textContent = 'No patients in queue.';
      queueList.appendChild(li);
      return;
    }
    snap.docs.forEach((d, i) => {
      const data = d.data();
      const li = document.createElement('li');
      li.style.padding = '8px 0';
      const tokenText = (typeof data.token === 'number') ? `#${data.token} ` : '';
      li.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-weight:700">${escapeHtml(tokenText + (data.name || 'Patient'))}</div>
          <div class="muted small">${escapeHtml(data.phone || '')} • ${escapeHtml(String(data.age || ''))} yrs • ${escapeHtml(data.city || '')}</div>
          <div class="muted small">Added: ${formatDate(data.createdAt)} • Status: ${escapeHtml(data.status || 'pending')}</div>
        </div>
        <div style="margin-left:12px">
          <button class="btn-done" data-id="${d.id}">Done</button>
          <button class="btn-remove" data-id="${d.id}" style="margin-left:6px">Remove</button>
        </div>
      </div>`;
      queueList.appendChild(li);
    });

    // attach handlers (use event delegation could be better, but keep simple)
    queueList.querySelectorAll('.btn-done').forEach(b => {
      b.onclick = async (ev) => {
        const id = ev.currentTarget.dataset.id;
        await markSingleDone(id).catch(err => setLoginMsg('Failed to mark done: ' + (err.message||err), true));
      };
    });
    queueList.querySelectorAll('.btn-remove').forEach(b => {
      b.onclick = async (ev) => {
        const id = ev.currentTarget.dataset.id;
        if (!confirm('Remove this entry from queue? This will mark it removed.')) return;
        await softRemoveEntry(id).catch(err => setLoginMsg('Failed to remove entry: ' + (err.message||err), true));
      };
    });
  }, (err) => {
    console.error('onSnapshot error', err);
    queueList.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = 'Failed to load queue: ' + (err.message || err);
    queueList.appendChild(li);
  });
}

// Mark first pending as done (uses ordering by token then createdAt)
markDoneBtn.addEventListener('click', async () => {
  if (!currentDoctorId) {
    setLoginMsg('Not signed in', true);
    return;
  }
  setLoginMsg('Marking current done...');
  try {
    let q = query(collection(db, 'doctors', currentDoctorId, 'queue'), where('status', '==', 'pending'), orderBy('token'), orderBy('createdAt'));
    let snap = await getDocs(q);
    let firstDoc = null;
    snap.forEach(d => { if (!firstDoc) firstDoc = d; });
    if (!firstDoc) {
      q = query(collection(db, 'doctors', currentDoctorId, 'queue'), where('status', '==', 'pending'), orderBy('createdAt'));
      snap = await getDocs(q);
      snap.forEach(d => { if (!firstDoc) firstDoc = d; });
    }
    if (!firstDoc) {
      setLoginMsg('No pending patients found.', true);
      return;
    }
    await markSingleDone(firstDoc.id);
    setLoginMsg('Marked done.');
  } catch (err) {
    console.error('markDone error', err);
    setLoginMsg('Failed to mark current: ' + (err.message || err), true);
  }
});

// mark single doc done (update status)
async function markSingleDone(docId) {
  if (!currentDoctorId) throw new Error('No doctor loaded');
  const ref = doc(db, 'doctors', currentDoctorId, 'queue', docId);
  await updateDoc(ref, { status: 'done', completedAt: serverTimestamp() });
}

// soft remove (mark removed) instead of deleting doc
async function softRemoveEntry(docId) {
  if (!currentDoctorId) throw new Error('No doctor loaded');
  const ref = doc(db, 'doctors', currentDoctorId, 'queue', docId);
  await updateDoc(ref, { status: 'removed', removedAt: serverTimestamp() });
}

// Add patient: use a transaction to allocate token atomically
addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  setLoginMsg('');
  if (!currentDoctorId) {
    setLoginMsg('Sign in first', true);
    return;
  }
  const name = (addName.value || '').trim();
  const phone = (addPhone.value || '').replace(/\D/g, '').slice(0, 10);
  const age = Number(addAge.value);
  const sex = addSex.value;
  const city = (addCity.value || '').trim();

  if (!name || !/^\d{10}$/.test(phone) || !age || !sex) {
    setLoginMsg('Please complete required fields with valid phone/age/sex.', true);
    return;
  }

  setLoginMsg('Adding patient...');
  try {
    const result = await createBookingWithTransaction(currentDoctorId, { name, phone, age, sex, city });
    setLoginMsg(`Added patient with token ${result.token}.`);
    addForm.reset();
  } catch (err) {
    console.error('add patient failed', err);
    setLoginMsg('Failed to add patient: ' + (err.message || err), true);
  }
});

// transaction-based token allocator (doctors/{id}/meta/counter)
async function createBookingWithTransaction(doctorId, payload) {
  const counterRef = doc(db, 'doctors', doctorId, 'meta', 'counter');
  const queueColRef = collection(db, 'doctors', doctorId, 'queue');

  return runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef);
    let nextToken = 1;
    if (counterSnap.exists()) {
      const data = counterSnap.data();
      if (data && typeof data.nextToken === 'number') nextToken = data.nextToken + 1;
    }
    tx.set(counterRef, { nextToken }, { merge: true });

    const newDocRef = doc(queueColRef); // random id
    const docPayload = {
      ...payload,
      token: nextToken,
      status: 'pending',
      createdAt: serverTimestamp()
    };
    tx.set(newDocRef, docPayload);
    return { id: newDocRef.id, token: nextToken };
  });
}

// mark holiday: append to doctors/{id}.holidays (arrayUnion-style implemented client-side)
markHolidayBtn.addEventListener('click', async () => {
  if (!currentDoctorId) {
    setLoginMsg('Sign in first', true);
    return;
  }
  const date = holidayDate.value;
  if (!date) {
    setLoginMsg('Pick a date', true);
    return;
  }
  setLoginMsg('Marking holiday...');
  try {
    const docRef = doc(db, 'doctors', currentDoctorId);
    const snap = await getDoc(docRef);
    const data = snap.exists() ? snap.data() : {};
    const holidays = Array.isArray(data.holidays) ? data.holidays.slice() : [];
    if (holidays.includes(date)) {
      setLoginMsg('Date already marked as holiday.', true);
      return;
    }
    holidays.push(date);
    await setDoc(docRef, { holidays }, { merge: true });
    setLoginMsg('Holiday marked for ' + date);
  } catch (err) {
    console.error('markHoliday failed', err);
    setLoginMsg('Failed to mark holiday: ' + (err.message || err), true);
  }
});

// download CSV of all queue entries
downloadBtn.addEventListener('click', async () => {
  if (!currentDoctorId) {
    setLoginMsg('Sign in first', true);
    return;
  }
  setLoginMsg('Preparing CSV...');
  try {
    const snap = await getDocs(query(collection(db, 'doctors', currentDoctorId, 'queue'), orderBy('createdAt')));
    const rows = [];
    snap.forEach(d => {
      const p = d.data();
      rows.push({
        id: d.id,
        name: p.name || '',
        phone: p.phone || '',
        age: p.age || '',
        sex: p.sex || '',
        city: p.city || '',
        token: (typeof p.token === 'number') ? p.token : '',
        status: p.status || '',
        createdAt: p.createdAt ? (p.createdAt.toDate ? p.createdAt.toDate().toISOString() : (p.createdAt.seconds ? new Date(p.createdAt.seconds * 1000).toISOString() : '')) : '',
        completedAt: p.completedAt ? (p.completedAt.toDate ? p.completedAt.toDate().toISOString() : (p.completedAt.seconds ? new Date(p.completedAt.seconds * 1000).toISOString() : '')) : ''
      });
    });

    if (rows.length === 0) {
      setLoginMsg('No records to download.', true);
      return;
    }

    const headers = ['id', 'name', 'phone', 'age', 'sex', 'city', 'token', 'status', 'createdAt', 'completedAt'];
    const csv = [headers.join(',')].concat(rows.map(r =>
      headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')
    )).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentDoctorId}_queue_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setLoginMsg('CSV downloaded.');
  } catch (err) {
    console.error('download CSV failed', err);
    setLoginMsg('Failed to generate CSV: ' + (err.message || err), true);
  }
});

// initialize (no-op, OTP flow drives sign-in)
(function init() {
  // nothing to run at load - user will sign in via OTP
})();