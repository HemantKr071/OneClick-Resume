console.log("🔥 Resume One-Click loaded");


/*
==========================================================
STATE
==========================================================
*/

let uploadInProgress = false;
let extensionHost = null;
let shadowRoot = null;

/*
    Widget element references (inside shadow DOM).
*/

let widgetCard = null;
let mainButton = null;
let dropdownToggleButton = null;
let closeButton = null;
let dropdownPanel = null;
let statusBar = null;

/*
    Widget behaviour flags.
*/

let dropdownOpen = false;

/*
    Set when the user closes the widget with ×.
    The widget stays hidden until a NEW upload UI
    appears (different detection signature).
*/

let widgetDismissed = false;
let dismissedSignature = null;

/*
    Dragging state.
*/

const DRAG_THRESHOLD_PX = 6;

let dragState = null;          // active pointer drag info
let suppressClickUntil = 0;    // timestamp: ignore clicks right after a drag

/*
    Cached restored position { left, top } from storage.
    Applied every time the widget becomes visible so we
    can re-clamp against the current viewport.
*/

let savedWidgetPosition = null;

/*
    Debounce timer for MutationObserver scans.
*/

let detectTimer = null;


/*
==========================================================
MESSAGING LAYER

Content scripts cannot read the extension's IndexedDB
(it would hit the WEBSITE's database instead), so all
resume access goes through the service worker.

The content script requests ONLY the resume it needs —
full payloads are never broadcast.
==========================================================
*/

function requestFromBackground(message) {
    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {

                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!response) {
                    reject(new Error("EMPTY_RESPONSE"));
                    return;
                }

                if (response.error) {
                    reject(new Error(response.error));
                    return;
                }

                resolve(response);
            });
        } catch (error) {

            /*
                Thrown synchronously when the extension
                context was invalidated (reload/update).
            */

            reject(error);
        }
    });
}

function isContextInvalidatedError(error) {
    return /context invalidated|Extension context/i.test(
        String(error?.message || "")
    );
}


/*
==========================================================
RESUME ACCESS HELPERS

Function names follow the V2 spec:

    getResumes()
    getDefaultResume()
    getResumeById()
==========================================================
*/

// Metadata list + defaultResumeId (no file payloads).
async function getResumes() {
    const response = await requestFromBackground({ type: "GET_RESUMES" });
    return response; // { resumes, defaultResumeId }
}

// Full record of the default resume (or null).
async function getDefaultResume() {
    const response = await requestFromBackground({
        type: "GET_DEFAULT_RESUME"
    });
    return response.resume || null;
}

// Full record of ONE resume by id (or null).
async function getResumeById(id) {
    const response = await requestFromBackground({
        type: "GET_RESUME_BY_ID",
        id
    });
    return response.resume || null;
}


/*
==========================================================
BASE64 -> FILE
==========================================================
*/

function base64ToFile(resume) {
    const binaryString = atob(resume.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: resume.type });
    return new File([blob], resume.name, {
        type: resume.type,
        lastModified: resume.lastModified
    });
}


/*
==========================================================
CENTRAL UPLOAD PIPELINE

There is exactly ONE path from a resume id to a
website's file input:

    resume id
      -> retrieve resume
      -> File reconstruction
      -> find / open upload control
      -> find file input
      -> DataTransfer
      -> input/change events

Both the main button (default resume) and the dropdown
(temporary selection) funnel through uploadResumeById().
==========================================================
*/

async function fetchTargetResume(resumeId) {
    if (resumeId) {
        const resume = await getResumeById(resumeId);
        if (!resume) {
            throw new Error("RESUME_NOT_FOUND");
        }
        return resume;
    }

    /*
        No id given -> use the DEFAULT resume.

        NOTE: temporary selections always pass an explicit
        id and therefore never touch or depend on changing
        the default here.
    */

    const def = await getDefaultResume();

    if (def) {
        return def;
    }

    /*
        Defensive fallback: default missing (e.g. deleted
        externally mid-session) but other resumes exist.
        Upload the first available WITHOUT changing the
        stored defaultResumeId.
    */

    const library = await getResumes();

    if (!library.resumes.length) {
        throw new Error("NO_RESUMES");
    }

    console.warn(
        "⚠️ No default resume set — falling back to first resume for THIS upload only"
    );

    const first = await getResumeById(library.resumes[0].id);

    if (!first) {
        throw new Error("NO_RESUMES");
    }

    return first;
}

async function uploadResumeById(resumeId) {
    console.log("⚡ uploadResumeById:", resumeId || "(default)");

    const resume = await fetchTargetResume(resumeId);

    if (!resume.data) {
        throw new Error("INVALID_RESUME_DATA");
    }

    console.log("📄 Uploading:", resume.name, `(${resume.size} bytes)`);

    const file = base64ToFile(resume);

    /*
        Step 1: an existing file input on the page?
    */

    let input = findResumeInput();
    if (input) {
        console.log("📄 Existing file input found");
        return await attachFileToInput(input, file);
    }

    /*
        Step 2: maybe it is being created right now.
    */

    input = await waitForResumeInput(3000);
    if (input) {
        console.log("📄 File input appeared");
        return await attachFileToInput(input, file);
    }

    /*
        Step 3: no input yet -> click an upload control
        (LinkedIn/Workday/Greenhouse-style) and wait for
        the input it creates.
    */

    return await openUploadAndAttach(file);
}


/*
==========================================================
ATTACH FILE TO INPUT (DataTransfer approach)

Extracted from V1's attachResume() so the payload can be
provided by the central pipeline instead of fetching the
resume internally.
==========================================================
*/

async function attachFileToInput(input, file) {
    if (!input) {
        throw new Error("FILE_INPUT_NOT_FOUND");
    }

    try {
        console.log("📎 Attaching resume...");

        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        input.files = dataTransfer.files;

        console.log("File count:", input.files.length);
        console.log("Attached file:", input.files[0]?.name);

        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        /*
            Some frameworks listen to blur as well.
        */

        input.dispatchEvent(new Event("blur", { bubbles: true }));

        input.dataset.resumeOneClickAttached = "true";

        console.log("✅ Resume attached successfully");
        return true;
    } catch (error) {
        console.error("❌ Resume attach failed:", error);
        return false;
    }
}


/*
==========================================================
GET FILE INPUTS
==========================================================
*/

function getFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')];
}


/*
==========================================================
GET TEXT AROUND ELEMENT
==========================================================
*/

function getElementText(element) {
    if (!element) return "";
    let text = "";
    text += " " + (element.innerText || element.textContent || "");
    text += " " + (element.getAttribute("aria-label") || "");
    text += " " + (element.getAttribute("title") || "");
    text += " " + (element.getAttribute("name") || "");
    text += " " + (element.id || "");
    if (element.parentElement) text += " " + (element.parentElement.innerText || "");
    return text.replace(/\s+/g, " ").trim().toLowerCase();
}


/*
==========================================================
SCORE FILE INPUT
==========================================================
*/

function getResumeScore(input) {
    let score = 0;
    const text = getElementText(input);
    const accept = (input.getAttribute("accept") || "").toLowerCase();


    /*
        Resume signals
    */

    if (
        /\bresume\b/i.test(text)
    ) {
        score += 100;
    }


    if (
        /\bcv\b/i.test(text)
    ) {
        score += 100;
    }


    if (
        /curriculum vitae/i.test(text)
    ) {
        score += 100;
    }


    /*
        File types
    */

    if (
        accept.includes(".pdf")
    ) {
        score += 20;
    }


    if (
        accept.includes(".doc")
    ) {
        score += 20;
    }


    if (
        accept.includes(".docx")
    ) {
        score += 20;
    }


    /*
        Negative signals
    */

    if (
        /cover letter/i.test(text)
    ) {
        score -= 100;
    }


    if (
        /profile photo/i.test(text)
    ) {
        score -= 100;
    }


    if (
        /profile picture/i.test(text)
    ) {
        score -= 100;
    }


    if (
        /\bphoto\b/i.test(text)
    ) {
        score -= 50;
    }


    if (
        /portfolio/i.test(text)
    ) {
        score -= 50;
    }


    return score;
}


/*
==========================================================
FIND BEST RESUME FILE INPUT
==========================================================
*/

function findResumeInput() {
    const inputs = getFileInputs().filter((input) => !input.closest("#resume-one-click-root"));
    if (inputs.length === 0) return null;
    if (inputs.length === 1) return inputs[0];
    const candidates = inputs.map(input => ({ input, score: getResumeScore(input) }));
    candidates.sort((a, b) => b.score - a.score);
    console.log("📊 Resume input candidates:", candidates);
    if (candidates[0] && candidates[0].score > 0) return candidates[0].input;
    return inputs[0];
}


/*
==========================================================
FIND UPLOAD CONTROL

Different websites use different elements:

    <button>
    <label>
    <div role="button">
    <div tabindex="0">

So we don't restrict ourselves
to only <button>.
==========================================================
*/

function findUploadControl() {
    const elements = [...document.querySelectorAll("button, label, [role='button']")];
    const candidates = [];
    for (const element of elements) {
        if (element.closest("#resume-one-click-root")) continue;
        const text = (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        const aria = (element.getAttribute("aria-label") || "").toLowerCase();
        const title = (element.getAttribute("title") || "").toLowerCase();


        /*
        ----------------------------------------
        Get nearby text as well.

        Example:

        <div>
            <span>Resume</span>
            <button>Upload</button>
        </div>

        The button itself may only say
        "Upload", so we need the parent context.
        ----------------------------------------
        */

        const parentText = (
            element.parentElement?.innerText ||
            ""
        )
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();


        const combined =
            `${text} ${aria} ${title} ${parentText}`;


        /*
        ----------------------------------------
        Must be an upload-related element
        ----------------------------------------
        */

        if (
            !/upload|attach|choose|select|add file/i
                .test(combined)
        ) {
            continue;
        }


        /*
        ----------------------------------------
        Ignore image/profile uploads
        ----------------------------------------
        */

        if (
            /photo|image|avatar|profile picture/i
                .test(combined)
        ) {
            continue;
        }


        /*
        ----------------------------------------
        IMPORTANT

        Only consider it a resume uploader
        if nearby text contains resume/CV.
        ----------------------------------------
        */

        const isResumeUpload =
            /\bresume\b/i.test(combined) ||
            /\bcv\b/i.test(combined) ||
            /curriculum vitae/i.test(combined);


        if (!isResumeUpload) {
            continue;
        }


        /*
        ----------------------------------------
        Calculate score
        ----------------------------------------
        */

        let score = 0;


        if (
            /upload\s+resume/i.test(combined)
        ) {
            score += 200;
        }


        if (
            /upload\s+cv/i.test(combined)
        ) {
            score += 200;
        }


        if (
            /attach\s+resume/i.test(combined)
        ) {
            score += 200;
        }


        if (
            /\bresume\b/i.test(combined)
        ) {
            score += 100;
        }


        if (
            /\bcv\b/i.test(combined)
        ) {
            score += 100;
        }


        if (
            /upload/i.test(combined)
        ) {
            score += 50;
        }


        if (
            /add file|choose file|select file|attach/i
                .test(combined)
        ) {
            score += 40;
        }


        candidates.push({
            element,
            text: combined,
            score
        });
    }


    /*
    ----------------------------------------
    Highest score first
    ----------------------------------------
    */

    candidates.sort(
        (a, b) =>
            b.score - a.score
    );


    console.log(
        "📊 REAL resume upload candidates:",
        candidates
    );


    return (
        candidates[0]?.element ||
        null
    );
}


/*
==========================================================
WAIT FOR FILE INPUT

Important for websites like:

    LinkedIn
    Workday
    Greenhouse
    etc.

The website may create the
<input type=file> asynchronously.
==========================================================
*/

async function waitForResumeInput(timeout = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const input = findResumeInput();
        if (input) {
            console.log("🎯 File input detected:", input);
            return input;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    console.log("⏰ Timed out waiting for file input");
    return null;
}


/*
==========================================================
OPEN UPLOAD AND ATTACH

Now parameterized by the reconstructed File so it stays
part of the single central pipeline.
==========================================================
*/

async function openUploadAndAttach(file) {
    const uploadControl = findUploadControl();

    if (!uploadControl) {
        throw new Error("UPLOAD_CONTROL_NOT_FOUND");
    }

    console.log("🎯 Upload control found:", uploadControl);

    /*
        Start waiting BEFORE clicking so the input is
        caught the moment the site creates it.
    */

    const inputPromise = waitForResumeInput(15000);

    uploadControl.click();

    const input = await inputPromise;

    if (!input) {
        throw new Error("FILE_INPUT_NOT_FOUND");
    }

    console.log("🎯 Dynamic file input detected:", input);

    return await attachFileToInput(input, file);
}


/*
==========================================================
WIDGET VISIBILITY
==========================================================
*/

function showResumeButton() {
    if (!extensionHost) return;
    ensureWidgetPosition();
    extensionHost.style.display = "block";
    console.log("👀 Resume upload detected → showing widget");
}

function hideResumeButton() {
    if (!extensionHost) return;
    extensionHost.style.display = "none";
    collapseResumeDropdown();
    console.log("🙈 No resume upload UI → hiding widget");
}


/*
----------------------------------------------------------
Detection signatures let us distinguish "the same upload
UI we already dismissed" from "a NEW upload UI".
----------------------------------------------------------
*/

function describeElement(el) {
    if (!el) return "null";
    const text = (el.innerText || el.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
    return `${el.tagName}|${el.id}|${el.className}|${text}`;
}

function getDetectionSignature() {
    const candidate = findResumeInput() || findUploadControl();
    return candidate ? describeElement(candidate) : null;
}


/*
==========================================================
CHECK FOR RESUME UPLOAD UI
==========================================================
*/

function detectResumeUploadUI() {
    const signature = getDetectionSignature();

    if (!signature) {
        hideResumeButton();
        return false;
    }

    /*
        Widget was closed with ×:
        stay hidden while it's the SAME upload UI,
        reshow when a NEW one appears.
    */

    if (widgetDismissed) {
        if (signature === dismissedSignature) {
            console.log("🙈 Widget previously dismissed for this UI → staying hidden");
            return false;
        }
        console.log("👀 New upload UI detected → un-dismissing widget");
        widgetDismissed = false;
        dismissedSignature = null;
    }

    showResumeButton();
    return true;
}


/*
==========================================================
WATCH FOR DYNAMIC UPLOAD UI (debounced)

The raw MutationObserver callback only schedules work;
the actual scan runs once mutations settle down, so
chatty sites don't trigger continuous full-page scans.
Scans are skipped entirely while an upload is in
progress.
==========================================================
*/

function scheduleDetection() {
    if (uploadInProgress) return;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(detectResumeUploadUI, 200);
}

function startUploadObserver() {
    const observer = new MutationObserver(scheduleDetection);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    console.log("👀 Resume upload observer started");
}


/*
==========================================================
CREATE EXTENSION UI (widget)

Structure inside the shadow root:

    ┌─────────────────────────────────────┐
    │ ⚡ Use Saved Resume       ▼      ×  │   <- drag handle
    ├─────────────────────────────────────┤
    │ ⭐ Hemant_Resume_SDE.pdf             │   <- dropdown panel
    │    Hemant_Backend.pdf                │
    └─────────────────────────────────────┘
       ✓ Hemant_Resume.pdf attached            <- status bar
==========================================================
*/

const WIDGET_CSS = `
    * { box-sizing: border-box; }

    .widget {
        all: initial;

        display: block;
        width: max-content;
        min-width: 230px;

        background: #111827;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);

        font-family: Arial, sans-serif;

        cursor: grab;
        user-select: none;
        -webkit-user-select: none;
        touch-action: none;
    }

    .widget.dragging {
        cursor: grabbing;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    }

    .header {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 8px;
    }

    .main-btn {
        flex: 1;

        padding: 8px 12px;

        background: transparent;
        color: #ffffff;

        border: none;
        border-radius: 6px;

        font-family: Arial, sans-serif;
        font-size: 14px;
        font-weight: 600;
        line-height: 1.4;

        cursor: pointer;
        white-space: nowrap;
    }

    .main-btn:hover {
        background: rgba(255, 255, 255, 0.08);
    }

    .icon-btn {
        padding: 4px 8px;

        background: transparent;
        color: #9ca3af;

        border: none;
        border-radius: 6px;

        font-family: Arial, sans-serif;
        font-size: 14px;
        font-weight: 700;
        line-height: 1;

        cursor: pointer;
    }

    .icon-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ffffff;
    }

    .dropdown {
        max-height: 240px;
        overflow-y: auto;

        border-top: 1px solid rgba(255, 255, 255, 0.12);

        cursor: default;
    }

    .resume-option {
        display: block;
        width: 100%;

        padding: 8px 14px;

        background: transparent;
        color: #e5e7eb;

        border: none;

        font-family: Arial, sans-serif;
        text-align: left;

        cursor: pointer;
    }

    .resume-option:hover {
        background: rgba(255, 255, 255, 0.08);
    }

    .resume-option.is-default .opt-name {
        color: #fde68a;
    }

    .opt-name {
        font-size: 13px;
        font-weight: 600;

        max-width: 240px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }

    .opt-size {
        margin-top: 2px;
        font-size: 11px;
        color: #9ca3af;
    }

    .dropdown-empty {
        padding: 10px 14px;
        font-size: 12px;
        color: #9ca3af;
    }

    .status {
        padding: 2px 14px 8px;
        font-size: 11px;
        color: #d1d5db;
    }

    .hidden {
        display: none !important;
    }
`;

function createResumeWidget() {
    if (document.getElementById("resume-one-click-root")) return;

    const host = document.createElement("div");
    host.id = "resume-one-click-root";

    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("top", "20px", "important");
    host.style.setProperty("right", "20px", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.display = "none";

    document.body.appendChild(host);
    extensionHost = host;

    shadowRoot = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    shadowRoot.appendChild(style);

    widgetCard = document.createElement("div");
    widgetCard.className = "widget";

    /*
        Header = drag handle + interactive controls.
    */

    const header = document.createElement("div");
    header.className = "header";

    mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "main-btn";
    mainButton.setAttribute("data-no-drag", "");
    mainButton.textContent = "⚡ Use Saved Resume";
    mainButton.addEventListener("click", () => handleMainButtonUpload());

    dropdownToggleButton = document.createElement("button");
    dropdownToggleButton.type = "button";
    dropdownToggleButton.className = "icon-btn";
    dropdownToggleButton.setAttribute("data-no-drag", "");
    dropdownToggleButton.textContent = "▼";
    dropdownToggleButton.title = "Show saved resumes";
    dropdownToggleButton.addEventListener("click", () => toggleResumeDropdown());

    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "icon-btn";
    closeButton.setAttribute("data-no-drag", "");
    closeButton.textContent = "×";
    closeButton.title = "Hide for this page";
    closeButton.addEventListener("click", () => closeWidget());

    header.append(mainButton, dropdownToggleButton, closeButton);

    dropdownPanel = document.createElement("div");
    dropdownPanel.className = "dropdown hidden";
    dropdownPanel.setAttribute("data-no-drag", "");

    statusBar = document.createElement("div");
    statusBar.className = "status hidden";

    widgetCard.append(header, dropdownPanel, statusBar);
    shadowRoot.appendChild(widgetCard);

    /*
        A click immediately after a drag must not reach
        the buttons (prevents accidental uploads/closes).
    */

    host.addEventListener(
        "click",
        (event) => {
            if (Date.now() < suppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true
    );

    makeWidgetDraggable(widgetCard);

    restoreWidgetPosition();

    window.addEventListener("resize", () => {
        if (extensionHost?.style.display !== "none") {
            ensureWidgetPosition();
        }
    });

    console.log("✅ Resume One-Click widget created");
}


/*
==========================================================
STATUS BAR
==========================================================
*/

function setStatus(message, autoClearMs = 4000) {
    if (!statusBar) return;
    statusBar.textContent = message;
    statusBar.classList.remove("hidden");

    if (autoClearMs) {
        setTimeout(() => {
            statusBar.classList.add("hidden");
        }, autoClearMs);
    }
}


/*
==========================================================
DROPDOWN

Lists ALL saved resumes. The default is marked with ⭐.
Clicking any resume performs a TEMPORARY upload of that
resume — it never changes defaultResumeId.
==========================================================
*/

function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function collapseResumeDropdown() {
    dropdownOpen = false;
    if (dropdownPanel) dropdownPanel.classList.add("hidden");
    if (dropdownToggleButton) dropdownToggleButton.textContent = "▼";
}

async function expandResumeDropdown() {
    dropdownOpen = true;
    if (dropdownToggleButton) dropdownToggleButton.textContent = "▲";
    if (dropdownPanel) dropdownPanel.classList.remove("hidden");
    await renderResumeDropdown();
}

async function toggleResumeDropdown(force) {
    const shouldOpen = typeof force === "boolean" ? force : !dropdownOpen;

    if (!shouldOpen) {
        collapseResumeDropdown();
        return;
    }

    await expandResumeDropdown();
}

async function renderResumeDropdown() {
    if (!dropdownPanel) return;
    dropdownPanel.innerHTML = "";

    try {
        const { resumes, defaultResumeId } = await getResumes();

        if (!resumes.length) {
            const empty = document.createElement("div");
            empty.className = "dropdown-empty";
            empty.textContent = "No saved resumes yet";
            dropdownPanel.appendChild(empty);
            return;
        }

        for (const meta of resumes) {
            const isDefault = meta.id === defaultResumeId;

            const option = document.createElement("button");
            option.type = "button";
            option.className =
                "resume-option" + (isDefault ? " is-default" : "");
            option.title = meta.name;

            const nameEl = document.createElement("div");
            nameEl.className = "opt-name";
            nameEl.textContent =
                (isDefault ? "⭐ " : "") + meta.name;

            const sizeEl = document.createElement("div");
            sizeEl.className = "opt-size";
            sizeEl.textContent = `${formatBytes(meta.size)} · ${
                meta.type || "file"
            }`;

            option.append(nameEl, sizeEl);

            option.addEventListener("click", () =>
                handleResumeSelection(meta.id, meta.name)
            );

            dropdownPanel.appendChild(option);
        }
    } catch (error) {
        console.error("❌ Failed to load resume list:", error);
        const empty = document.createElement("div");
        empty.className = "dropdown-empty";
        empty.textContent = isContextInvalidatedError(error)
            ? "Extension updated — reload this page"
            : "Failed to load resumes";
        dropdownPanel.appendChild(empty);
    }
}


/*
==========================================================
UPLOAD ACTIONS
==========================================================
*/

function describeUploadError(error) {
    const code = String(error?.message || error);

    if (isContextInvalidatedError(error)) {
        return "❌ Extension updated — reload this page";
    }

    switch (code) {
        case "NO_RESUMES":
            return "❌ No saved resumes";
        case "RESUME_NOT_FOUND":
            return "❌ Resume not found";
        case "INVALID_RESUME_DATA":
            return "❌ Resume data invalid";
        case "UPLOAD_CONTROL_NOT_FOUND":
            return "❌ Upload control not found";
        case "FILE_INPUT_NOT_FOUND":
            return "❌ File input not found";
        case "EMPTY_RESPONSE":
            return "❌ Extension did not respond";
        default:
            console.error("❌ Upload failed:", error);
            return "❌ Upload Failed";
    }
}

/*
    Single entry point used by BOTH the main button
    (targetId undefined → default resume) and the
    dropdown (explicit targetId → temporary selection).
*/

async function runUpload(targetId, displayName) {
    if (uploadInProgress) return false;

    uploadInProgress = true;

    try {
        setStatus(
            displayName
                ? `⏳ Attaching ${displayName}…`
                : "⏳ Uploading..."
        );

        const ok = await uploadResumeById(targetId);

        if (ok) {
            setStatus(
                `✅ Attached${displayName ? ` ${displayName}` : ""}`
            );
        } else {
            setStatus("❌ Upload Failed");
        }

        return ok;
    } catch (error) {
        setStatus(describeUploadError(error));
        return false;
    } finally {
        uploadInProgress = false;
    }
}

/*
    Main button = ALWAYS the default resume.
    Never changes which resume IS the default.
*/

async function handleMainButtonUpload() {
    if (uploadInProgress) return;

    mainButton.textContent = "⏳ Uploading...";
    collapseResumeDropdown();

    const ok = await runUpload(undefined);

    if (ok) {
        mainButton.textContent = "✓ Resume Attached";
    } else {
        mainButton.textContent = "❌ Upload Failed";
    }

    setTimeout(() => {
        mainButton.textContent = "⚡ Use Saved Resume";
    }, 2000);
}

/*
    Dropdown selection = TEMPORARY for this upload only.
    defaultResumeId in storage is NEVER touched here.
*/

async function handleResumeSelection(resumeId, resumeName) {
    if (uploadInProgress) return;

    collapseResumeDropdown();

    console.log(
        "🎯 Temporary resume selected:",
        resumeName,
        "(default unchanged)"
    );

    await runUpload(resumeId, resumeName);
}


/*
==========================================================
CLOSE BUTTON

Hides the widget for the current page/session.
Does NOT delete resumes and NEVER touches the default
resume or the extension state. If a NEW upload UI
appears later, the widget comes back automatically.
==========================================================
*/

function closeWidget() {
    widgetDismissed = true;
    dismissedSignature = getDetectionSignature();
    hideResumeButton();
    console.log("🙈 Widget dismissed by user");
}


/*
==========================================================
DRAGGING (Pointer Events)

- Only the widget surface acts as drag handle.
  Buttons and the dropdown are marked data-no-drag.
- Movement below DRAG_THRESHOLD_PX counts as a click,
  anything above starts a drag.
- After a real drag, the imminent click event is
  suppressed so releasing the pointer never triggers
  an upload/toggle/close.
- Position is clamped inside the viewport and saved
  to chrome.storage.local on drop.
==========================================================
*/

function clampPosition(left, top, width, height) {
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);

    return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop)
    };
}

function applyWidgetPosition(left, top) {
    if (!extensionHost) return;
    extensionHost.style.setProperty("left", `${Math.round(left)}px`, "important");
    extensionHost.style.setProperty("top", `${Math.round(top)}px`, "important");
    extensionHost.style.setProperty("right", "auto", "important");
}

function makeWidgetDraggable(handle) {
    handle.addEventListener("pointerdown", (event) => {

        if (event.button !== 0) return;
        if (event.target.closest("[data-no-drag]")) return;

        const rect = handle.getBoundingClientRect();

        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: rect.left,
            startTop: rect.top,
            moved: false
        };

        try {
            handle.setPointerCapture(event.pointerId);
        } catch {
            /* capture unsupported — dragging still works */
        }
    });

    handle.addEventListener("pointermove", (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;

        if (!dragState.moved) {
            if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
            dragState.moved = true;
            handle.classList.add("dragging");
        }

        const rect = handle.getBoundingClientRect();

        const { left, top } = clampPosition(
            dragState.startLeft + dx,
            dragState.startTop + dy,
            rect.width,
            rect.height
        );

        applyWidgetPosition(left, top);
    });

    const endDrag = (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const moved = dragState.moved;
        dragState = null;

        handle.classList.remove("dragging");

        if (moved) {
            suppressClickUntil = Date.now() + 300;
            saveWidgetPosition();
        }
    };

    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);

    /*
        Swallow native drag behaviours.
    */

    handle.addEventListener("dragstart", (e) => e.preventDefault());
}


/*
==========================================================
POSITION PERSISTENCE

    chrome.storage.local:
    {
        widgetPosition: { left: 1100, top: 100 }
    }

Restored on load and re-clamped into the viewport every
time the widget becomes visible, so stale/off-screen
saved positions can never strand the widget.
==========================================================
*/

function saveWidgetPosition() {
    if (!extensionHost) return;

    const rect = extensionHost.getBoundingClientRect();

    const position = {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
    };

    savedWidgetPosition = position;

    try {
        chrome.storage.local.set({ widgetPosition: position }, () => {
            if (chrome.runtime.lastError) {
                console.warn(
                    "⚠️ Could not save widget position:",
                    chrome.runtime.lastError.message
                );
                return;
            }
            console.log("💾 Widget position saved:", position);
        });
    } catch (error) {
        console.warn("⚠️ Could not save widget position:", error);
    }
}

function restoreWidgetPosition() {
    try {
        chrome.storage.local.get("widgetPosition", (result) => {
            if (chrome.runtime.lastError) {
                console.warn(
                    "⚠️ Could not restore widget position:",
                    chrome.runtime.lastError.message
                );
                return;
            }

            const position = result.widgetPosition;

            if (
                position &&
                Number.isFinite(position.left) &&
                Number.isFinite(position.top)
            ) {
                savedWidgetPosition = position;
                console.log(
                    "💾 Restored widget position:",
                    position
                );
            }
        });
    } catch (error) {
        console.warn("⚠️ Could not restore widget position:", error);
    }
}

/*
    Re-apply (and clamp) the cached position whenever
    the widget becomes visible. While hidden its size
    is 0, so this must happen AFTER showing.
*/

function ensureWidgetPosition() {
    if (!extensionHost || !savedWidgetPosition) return;

    const rect = extensionHost.getBoundingClientRect();

    const { left, top } = clampPosition(
        savedWidgetPosition.left,
        savedWidgetPosition.top,
        rect.width || 230,
        rect.height || 48
    );

    applyWidgetPosition(left, top);
}


/*
==========================================================
INITIALIZE

Idempotent: websites can navigate internally and inject
content scripts more than once, but the
#resume-one-click-root guard guarantees there is never
more than one widget.
==========================================================
*/

function initialize() {
    createResumeWidget();
    detectResumeUploadUI();
    startUploadObserver();
    console.log("🚀 Resume One-Click initialized");
}

if (document.body) {
    initialize();
} else {
    window.addEventListener("DOMContentLoaded", initialize);
}
