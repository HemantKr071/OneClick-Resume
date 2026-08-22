/*
=====================================================
One-Click Resume — Background Service Worker (V2)

The service worker is the ONLY component that exposes
resume data to content scripts. Websites never see
anything except the file that gets attached.

All storage logic lives in storage/resume-db.js which
is imported below (same copy the popup uses).
=====================================================
*/

importScripts("../storage/resume-db.js");

console.log("🔥 Resume One-Click service worker loaded");


/*
-----------------------------------------------------
Message handlers.

Each handler returns a plain object that becomes the
sendResponse payload. Errors are normalized into

    { error: "SOME_CODE_OR_MESSAGE" }

so callers can react consistently.
-----------------------------------------------------
*/

const handlers = {

    /*
        Metadata for ALL saved resumes + default id.
        No base64 payloads are sent here on purpose:
        listing must stay cheap.
    */
    async GET_RESUMES() {
        return getResumes();
    },

    /*
        Full record of the default resume.
        Used by the widget's main button and by the
        legacy content-script flow.
    */
    async GET_DEFAULT_RESUME() {
        return { resume: await getDefaultResume() };
    },

    /*
        Full record of ONE resume by id.
        The content script requests only the resume it
        needs (temporary dropdown selection).
    */
    async GET_RESUME_BY_ID(message) {
        if (!message.id) {
            return { error: "MISSING_RESUME_ID" };
        }
        return { resume: await getResumeById(message.id) };
    },

    /*
        Save a new resume. The worker generates the id,
        never trusting caller-supplied ids.
    */
    async SAVE_RESUME(message) {
        const r = message.resume;
        if (!r || !r.data) {
            return { error: "INVALID_RESUME" };
        }
        const saved = await saveResumeRecord(r);
        return {
            resume: metaFromRecord(saved),
            defaultResumeId: await getDefaultResumeId()
        };
    },

    async DELETE_RESUME(message) {
        if (!message.id) {
            return { error: "MISSING_RESUME_ID" };
        }
        return deleteResumeRecord(message.id);
    },

    async SET_DEFAULT_RESUME(message) {
        if (!message.id) {
            return { error: "MISSING_RESUME_ID" };
        }
        return setDefaultResumeId(message.id);
    },

    /*
    -------------------------------------------------
        LEGACY (V1) MESSAGE — kept temporarily so any
        old callers keep working. Maps onto the new
        "get default resume" flow and preserves the
        original response shape:

            { resume: { name, type, size,
                        lastModified, data } }

            { resume: null }   when nothing is stored
    -------------------------------------------------
    */
    async GET_RESUME() {
        const resume = await getDefaultResume();
        return { resume };
    }
};


/*
-----------------------------------------------------
Single message listener routes every request through
the handler table. Returning true keeps the message
channel open for the asynchronous sendResponse call.
-----------------------------------------------------
*/

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("📩 Message:", message?.type);

    const handler = handlers[message?.type];

    if (!handler) {
        sendResponse({ error: "UNKNOWN_MESSAGE_TYPE" });
        return false;
    }

    handler(message)
        .then((response) => sendResponse(response))
        .catch((error) => {
            console.error(`❌ ${message.type} failed:`, error);
            sendResponse({ error: error?.message || String(error) });
        });

    return true; // asynchronous response
});
