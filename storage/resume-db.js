/*
=====================================================
Resume DB (V2)

Storage mechanism preserved from V1: IndexedDB.

    Database:   "resume-one-click"
    Store:      "resumes"

V2 schema (logical shape requested by V2 spec):

    "__index__"  ->  {
        resumes: [                      // metadata only (no file data)
            { id, name, type, size, lastModified },
            ...
        ],
        defaultResumeId: "resume-id" | null
    }

    "<resume-id>"  ->  {                 // full record, one per resume
        id,
        name,
        data,                            // base64 payload
        type,
        size,
        lastModified
    }

This keeps GET_RESUMES cheap (metadata only) while
GET_RESUME_BY_ID fetches exactly one file payload.

Legacy V1 data looked like:

    "default"  ->  File / Blob           // single saved resume

Migration converts that into the V2 schema exactly once
and then removes the legacy key. See migrateLegacyResume().
=====================================================
*/

const DB_NAME = "resume-one-click";
const DB_VERSION = 1;
const STORE_NAME = "resumes";

const INDEX_KEY = "__index__";
const LEGACY_KEY = "default";

const MAX_RESUME_BYTES = 10 * 1024 * 1024; // 10 MB safety limit


/*
-----------------------------------------------------
Open IndexedDB (unchanged from V1).
-----------------------------------------------------
*/

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


/*
-----------------------------------------------------
Small promise wrappers around IndexedDB requests.

Every wrapper opens its own transaction, so each
operation is atomic on its own.
-----------------------------------------------------
*/

function idbGet(key) {
    return openResumeDB().then((db) =>
        new Promise((resolve, reject) => {
            const request = db
                .transaction(STORE_NAME, "readonly")
                .objectStore(STORE_NAME)
                .get(key);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        })
    );
}

function idbPut(key, value) {
    return openResumeDB().then((db) =>
        new Promise((resolve, reject) => {
            const request = db
                .transaction(STORE_NAME, "readwrite")
                .objectStore(STORE_NAME)
                .put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        })
    );
}

function idbDelete(key) {
    return openResumeDB().then((db) =>
        new Promise((resolve, reject) => {
            const request = db
                .transaction(STORE_NAME, "readwrite")
                .objectStore(STORE_NAME)
                .delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        })
    );
}


/*
-----------------------------------------------------
Convert File/Blob -> base64 string (no data-url prefix).
Shared by the service worker (legacy migration) and the
popup (saving newly selected files).
-----------------------------------------------------
*/

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            /*
                Example result:

                "data:application/pdf;base64,JVBERi0xLjQK..."

                We strip everything before the comma.
            */
            resolve(reader.result.split(",")[1]);
        };

        reader.onerror = () => reject(reader.error);

        reader.readAsDataURL(blob);
    });
}


/*
-----------------------------------------------------
Generate a unique resume id.
-----------------------------------------------------
*/

function generateResumeId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return `resume-${crypto.randomUUID()}`;
    }
    return `resume-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}


/*
=====================================================
LEGACY MIGRATION (V1 -> V2)

Old format:

    "default" -> File

New format:

    "<generated-id>" -> full record
    "__index__"      -> { resumes: [meta], defaultResumeId }

Runs at most once per context (memoized), is idempotent
across contexts (guarded by presence of the legacy key),
and never destroys legacy data unless every write
succeeded.
=====================================================
*/

let migrationPromise = null;

function ensureMigrated() {
    if (!migrationPromise) {
        migrationPromise = migrateLegacyResume().catch((error) => {
            console.error("❌ Resume migration failed:", error);

            /*
                Allow retry on the next call instead of
                caching a failed migration forever.
            */
            migrationPromise = null;
            throw error;
        });
    }
    return migrationPromise;
}

async function migrateLegacyResume() {
    const legacy = await idbGet(LEGACY_KEY);
    if (!legacy) return; // nothing to migrate (fresh install or already migrated)

    console.log("📄 Legacy resume found -> migrating to multi-resume schema...");

    const base64 =
        typeof legacy === "string"
            ? legacy
            : await blobToBase64(legacy);

    const record = {
        id: generateResumeId(),
        name: legacy.name || "Saved_Resume",
        type: legacy.type || "application/pdf",
        size: legacy.size || 0,
        lastModified: legacy.lastModified || Date.now(),
        data: base64
    };

    await idbPut(record.id, record);
    await idbPut(INDEX_KEY, {
        resumes: [metaFromRecord(record)],
        defaultResumeId: record.id
    });

    /*
        Only remove the legacy key after both writes
        succeeded, so a crash mid-migration can be retried.
    */
    await idbDelete(LEGACY_KEY);

    console.log("✅ Legacy resume migrated:", record.name);
}


/*
-----------------------------------------------------
Index helpers.
-----------------------------------------------------
*/

function emptyIndex() {
    return { resumes: [], defaultResumeId: null };
}

function metaFromRecord(record) {
    return {
        id: record.id,
        name: record.name,
        type: record.type,
        size: record.size,
        lastModified: record.lastModified
    };
}

async function readIndex() {
    const index = await idbGet(INDEX_KEY);
    return index && Array.isArray(index.resumes) ? index : emptyIndex();
}

async function writeIndex(index) {
    await idbPut(INDEX_KEY, index);
}


/*
=====================================================
PUBLIC API

Used directly by the popup page and by the background
service worker (via importScripts).
=====================================================
*/

// Metadata list (no file payloads) + current default.
async function getResumes() {
    await ensureMigrated();
    const index = await readIndex();
    return {
        resumes: index.resumes,
        defaultResumeId: index.defaultResumeId
    };
}

// Default resume id (or null when none).
async function getDefaultResumeId() {
    await ensureMigrated();
    const index = await readIndex();
    return index.defaultResumeId || null;
}

// Full record including base64 data, or null.
async function getResumeById(id) {
    await ensureMigrated();
    if (!id) return null;
    return idbGet(id);
}

// Full record of the default resume, or null.
async function getDefaultResume() {
    await ensureMigrated();
    const index = await readIndex();
    if (!index.defaultResumeId) return null;
    return idbGet(index.defaultResumeId);
}

/*
    Save a new resume.

    payload: { name, type, size, lastModified, data(base64) }

    Returns the stored record (with generated id).
    The first resume ever saved automatically becomes
    the default so the widget works immediately.
*/
async function saveResumeRecord(payload) {
    await ensureMigrated();

    const record = {
        id: generateResumeId(),
        name: String(payload.name || "Untitled_Resume"),
        type: String(payload.type || ""),
        size: Number(payload.size || 0),
        lastModified: Number(payload.lastModified || Date.now()),
        data: String(payload.data || "")
    };

    if (!record.data) {
        throw new Error("EMPTY_RESUME_DATA");
    }

    if (record.size > MAX_RESUME_BYTES) {
        throw new Error("RESUME_TOO_LARGE");
    }

    const index = await readIndex();

    if (index.resumes.some((r) => r.name === record.name)) {
        throw new Error("DUPLICATE_NAME");
    }

    index.resumes.push(metaFromRecord(record));

    if (!index.defaultResumeId) {
        index.defaultResumeId = record.id;
    }

    await idbPut(record.id, record);
    await writeIndex(index);

    console.log("✅ Resume saved:", record.name, `(${record.id})`);
    return record;
}

/*
    Delete a resume by id.

    If it was the default, another remaining resume is
    promoted automatically; with no resumes left the
    default becomes null.
*/
async function deleteResumeRecord(id) {
    await ensureMigrated();

    const index = await readIndex();
    const exists = index.resumes.some((r) => r.id === id);

    if (!exists) {
        throw new Error("RESUME_NOT_FOUND");
    }

    await idbDelete(id);

    index.resumes = index.resumes.filter((r) => r.id !== id);

    let promoted = false;
    if (index.defaultResumeId === id) {
        index.defaultResumeId = index.resumes.length
            ? index.resumes[0].id
            : null;
        promoted = Boolean(index.defaultResumeId);
    }

    await writeIndex(index);

    console.log(
        "🗑️ Resume deleted:",
        id,
        promoted
            ? "-> new default promoted"
            : index.defaultResumeId
              ? ""
              : "-> no resumes left, default cleared"
    );

    return {
        ok: true,
        defaultResumeId: index.defaultResumeId
    };
}

/*
    Mark exactly one resume as default.
*/
async function setDefaultResumeId(id) {
    await ensureMigrated();

    const index = await readIndex();
    const exists = index.resumes.some((r) => r.id === id);

    if (!exists) {
        throw new Error("RESUME_NOT_FOUND");
    }

    index.defaultResumeId = id;
    await writeIndex(index);

    console.log("⭐ Default resume set:", id);
    return { ok: true, defaultResumeId: id };
}
