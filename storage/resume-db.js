const DB_NAME = "resume-one-click";
const DB_VERSION = 1;
const STORE_NAME = "resumes";

function openResumeDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// Save the user's resume. We use a fixed key "default" because V1 supports one resume.
async function saveResume(file) {
    const db = await openResumeDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(file, "default");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// Get the saved resume.
async function getResume() {
    const db = await openResumeDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get("default");
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

// Delete saved resume.
async function deleteResume() {
    const db = await openResumeDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete("default");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}