// app.js (module) — improved booking flow with transactional token allocation
// Uses Firebase v9 modular SDK. Replace your existing app.js with this file.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js';
import {
  getFirestore, collection, addDoc, doc, getDoc,
  query, where, orderBy, getDocs, serverTimestamp,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/9.22.1/firebase-firestore.js';

// --- Firebase config (your provided project) ---
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

// Doctor list (IDs must match Firestore docs)
const DOCTORS = [
  { id: 'ansari', name: 'Dr. Ansari (MBBS)' },
  { id: 'khan', name: 'Dr. Khan (MBBS)' },
  { id: 'patel', name: 'Dr. Patel (MBBS)' }
];

const doctorsEl = document.getElementById('doctors');
const bookingSection = document.getElementById('booking-section');
const bookingForm = document.getElementById('booking-form');
const selectedDoctorName = document.getElementById('selected-doctor-name');
const bookingMsg = document.getElementById('booking-msg');
const confirmationSection = document.getElementById('confirmation-section');
const confText = document.getElementById('conf-text');
const backToListBtn = document.getElementById('back-to-list');
const doneOkBtn = document.getElementById('done-ok');

let selectedDoctor = null;

function renderDoctors(){
  doctorsEl.innerHTML = '';
  DOCTORS.forEach(d => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.display = 'flex';
    card.style.justifyContent = 'space-between';
    card.style.alignItems = 'center';
    card.style.padding = '10px';
    card.innerHTML = `<div><strong>${escapeHtml(d.name)}</strong></div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Book';
    btn.addEventListener('click', ()=> selectDoctor(d));
    card.appendChild(btn);
    doctorsEl.appendChild(card);
  });
}

function selectDoctor(d){
  selectedDoctor = d;
  selectedDoctorName.textContent = d.name;
  bookingSection.classList.remove('hidden');
  confirmationSection.classList.add('hidden');
  bookingMsg.textContent = '';
  // focus the first form input if available
  setTimeout(() => {
    const nameInput = document.getElementById('patient-name');
    if (nameInput) nameInput.focus();
  }, 50);
}

backToListBtn.addEventListener('click', ()=>{
  bookingSection.classList.add('hidden');
  selectedDoctor = null;
});

doneOkBtn.addEventListener('click', ()=>{
  confirmationSection.classList.add('hidden');
  bookingSection.classList.add('hidden');
  selectedDoctor = null;
});

async function isHoliday(doctorId, dateStr){
  try {
    const ref = doc(db, 'doctors', doctorId);
    const snap = await getDoc(ref);
    if(!snap.exists()) return false;
    const data = snap.data();
    if(!data || !data.holidays) return false;
    // expect holidays to be array of strings like 'YYYY-MM-DD'
    return Array.isArray(data.holidays) && data.holidays.includes(dateStr);
  } catch (err) {
    console.warn('Holiday check failed:', err);
    // fail-open: if holiday check fails, assume available so users can still book
    return false;
  }
}

function validateInputs({ name, phone, age, sex, city }) {
  const errors = [];
  if (!name || name.length < 2) errors.push('Enter your full name (min 2 chars).');
  if (!/^\d{10}$/.test(phone)) errors.push('Phone must be exactly 10 digits.');
  const ageNum = Number(age);
  if (!Number.isFinite(ageNum) || ageNum <= 0 || ageNum > 120) errors.push('Enter a valid age.');
  if (!sex || sex.trim() === '') errors.push('Select sex.');
  if (!city || city.length < 2) errors.push('Enter your city/village.');
  return errors;
}

/*
  Atomic token assignment (recommended):
  We keep a per-doctor meta doc at:
    doctors/{doctorId}/meta/counter  (document with field: nextToken:number)
  The transaction reads the counter, increments and writes it back, and creates the queue entry
  with the assigned token. This avoids races when multiple clients book at once.
*/
async function createBookingWithTransaction(doctorId, payload) {
  // meta doc path
  const counterRef = doc(db, 'doctors', doctorId, 'meta', 'counter');
  const queueColRef = collection(db, 'doctors', doctorId, 'queue');

  return runTransaction(db, async (tx) => {
    const counterSnap = await tx.get(counterRef);
    let nextToken = 1;
    if (counterSnap.exists()) {
      const data = counterSnap.data();
      if (data && typeof data.nextToken === 'number') {
        nextToken = data.nextToken + 1;
      }
    }
    // set new counter value (merge to avoid wiping other metadata)
    tx.set(counterRef, { nextToken }, { merge: true });

    // create queue doc with assigned token
    const newDocRef = doc(queueColRef); // random id
    const docPayload = {
      ...payload,
      token: nextToken,
      status: 'pending',
      createdAt: serverTimestamp()
    };
    tx.set(newDocRef, docPayload);

    // return new doc id and token
    return { id: newDocRef.id, token: nextToken };
  });
}

bookingForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!selectedDoctor) {
    bookingMsg.textContent = 'Select doctor first';
    return;
  }

  // read & sanitize inputs
  const name = document.getElementById('patient-name').value.trim();
  const phone = document.getElementById('patient-phone').value.replace(/\D/g, '').slice(0,10); // only digits
  const age  = document.getElementById('patient-age').value.trim();
  const sex  = document.getElementById('patient-sex').value;
  const city = document.getElementById('patient-city').value.trim();

  const inputData = { name, phone, age, sex, city };
  const errors = validateInputs(inputData);
  if (errors.length) {
    bookingMsg.textContent = errors.join(' ');
    return;
  }

  // check holiday for today (client local date in YYYY-MM-DD)
  const today = new Date().toISOString().slice(0,10);
  bookingMsg.textContent = 'Checking availability...';
  try {
    const holiday = await isHoliday(selectedDoctor.id, today);
    if (holiday) {
      bookingMsg.textContent = 'Doctor not available today (holiday).';
      return;
    }
  } catch (err) {
    bookingMsg.textContent = 'Availability check failed. Try again later.';
    console.error(err);
    return;
  }

  // disable submit while processing
  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const prevText = submitBtn.textContent;
  submitBtn.textContent = 'Processing...';

  bookingMsg.textContent = 'Processing payment... (simulated)';

  try {
    // Prepare payload (avoid storing unnecessary client-only fields)
    const payload = {
      name,
      phone,
      age: Number(age),
      sex,
      city,
      // status, token, createdAt will be set inside transaction
    };

    // Use transaction to allocate token atomically
    const result = await createBookingWithTransaction(selectedDoctor.id, payload);

    bookingMsg.textContent = '';
    confirmationSection.classList.remove('hidden');
    bookingSection.classList.add('hidden');
    confText.innerHTML = `Appointment booked with <strong>${escapeHtml(selectedDoctor.name)}</strong>.<br/>Your Token No: <strong>${result.token}</strong>.<br/>Reference ID: <strong>${escapeHtml(result.id)}</strong>`;
    bookingForm.reset();
  } catch (err) {
    console.error('Booking error:', err);
    bookingMsg.textContent = 'Error booking: ' + (err && err.message ? err.message : String(err));
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = prevText;
  }
});

renderDoctors();

/* small util */
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}