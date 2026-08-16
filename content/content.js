console.log("🔥 Resume One-Click loaded");


/*
===========================================================
STATE
===========================================================
*/

let uploadInProgress = false;
let extensionHost = null;


/*
===========================================================
GET SAVED RESUME
===========================================================
*/

async function getSavedResume() {
    const response = await chrome.runtime.sendMessage({ type: "GET_RESUME" });
    if (!response || !response.resume) throw new Error("No saved resume found");
    return response.resume;
}


/*
===========================================================
BASE64 -> FILE
===========================================================
*/

function base64ToFile(resume) {
    const binaryString = atob(resume.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    const blob = new Blob([bytes], { type: resume.type });
    return new File([blob], resume.name, { type: resume.type, lastModified: resume.lastModified });
}


/*
===========================================================
ATTACH RESUME TO FILE INPUT
===========================================================
*/

async function attachResume(input) {
    if (!input) return false;
    try {
        console.log("📎 Attaching resume...");
        const resume = await getSavedResume();
        console.log("Resume:", resume.name, resume.size);
        const file = base64ToFile(resume);
        console.log("Reconstructed file:", file);
        console.log("Original resume size:", resume.size);
        console.log("Reconstructed file size:", file.size);
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        input.files = dataTransfer.files;
        console.log("File count:", input.files.length);
        console.log("Attached file:", input.files[0]?.name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));


        /*
            Some frameworks listen to
            blur as well.
        */

        input.dispatchEvent(new Event("blur", { bubbles: true }));
        input.dataset.resumeOneClickAttached = "true";
        uploadInProgress = false;
        console.log("✅ Resume attached successfully");
        return true;
    } catch (error) {
        uploadInProgress = false;
        console.error("❌ Resume upload failed:", error);
        return false;
    }
}


/*
===========================================================
GET FILE INPUTS
===========================================================
*/

function getFileInputs() {
    return [...document.querySelectorAll('input[type="file"]')];
}


/*
===========================================================
GET TEXT AROUND ELEMENT
===========================================================
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
===========================================================
SCORE FILE INPUT
===========================================================
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
===========================================================
FIND BEST RESUME FILE INPUT
===========================================================
*/

function findResumeInput() {
    const inputs = getFileInputs();
    if (inputs.length === 0) return null;
    if (inputs.length === 1) return inputs[0];
    const candidates = inputs.map(input => ({ input, score: getResumeScore(input) }));
    candidates.sort((a, b) => b.score - a.score);
    console.log("📊 Resume input candidates:", candidates);
    if (candidates[0] && candidates[0].score > 0) return candidates[0].input;
    return inputs[0];
}


/*
===========================================================
FIND UPLOAD CONTROL
===========================================================

Different websites use different elements:

    <button>
    <label>
    <div role="button">
    <div tabindex="0">

So we don't restrict ourselves
to only <button>.
===========================================================
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
===========================================================
WAIT FOR FILE INPUT
===========================================================

Important for websites like:

    LinkedIn
    Workday
    Greenhouse
    etc.

The website may create the
<input type=file> asynchronously.
===========================================================
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
===========================================================
OPEN UPLOAD AND ATTACH
===========================================================
*/

async function openUploadAndAttach() {
    const uploadControl = findUploadControl();
    if (!uploadControl) {
        console.log("❌ Upload control not found");
        return false;
    }
    console.log("🎯 Upload control found:", uploadControl);
    uploadInProgress = true;
    const inputPromise = waitForResumeInput(15000);
    uploadControl.click();
    const input = await inputPromise;
    if (!input) {
        uploadInProgress = false;
        console.log("❌ Upload clicked but no file input appeared");
        return false;
    }
    console.log("🎯 Dynamic file input detected:", input);
    return await attachResume(input);
}


/*
===========================================================
MAIN RESUME ACTION
===========================================================
*/

async function useSavedResume() {
    console.log("⚡ Use Saved Resume clicked");
    let input = findResumeInput();
    if (input) {
        console.log("📄 Existing file input found");
        return await attachResume(input);
    }
    console.log("🔎 No file input found.");
    input = await waitForResumeInput(3000);
    if (input) {
        console.log("📄 File input appeared");
        return await attachResume(input);
    }
    return await openUploadAndAttach();
}


/*
===========================================================
SHOW EXTENSION BUTTON
===========================================================
*/

function showResumeButton() {
    if (!extensionHost) return;
    extensionHost.style.display = "block";
    console.log("👀 Resume upload detected → showing button");
}

function hideResumeButton() {
    if (!extensionHost) return;
    extensionHost.style.display = "none";
    console.log("🙈 No resume upload UI → hiding button");
}


/*
===========================================================
CHECK FOR RESUME UPLOAD UI
===========================================================
*/

function detectResumeUploadUI() {
    const input = findResumeInput();
    if (input) {
        showResumeButton();
        return true;
    }
    const uploadControl = findUploadControl();
    if (uploadControl) {
        showResumeButton();
        return true;
    }
    hideResumeButton();
    return false;
}


/*
===========================================================
WATCH FOR DYNAMIC UPLOAD UI
===========================================================
*/

function startUploadObserver() {
    const observer = new MutationObserver(() => {
        if (uploadInProgress) return;
        detectResumeUploadUI();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    console.log("👀 Resume upload observer started");
}


/*
===========================================================
CREATE EXTENSION UI
===========================================================
*/

function createExtensionUI() {
    if (document.getElementById("resume-one-click-root")) return;
    const host = document.createElement("div");
    host.id = "resume-one-click-root";
    extensionHost = host;
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("right", "20px", "important");
    host.style.setProperty("bottom", "20px", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    document.body.appendChild(host);
    host.style.display = "none";
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "⚡ Use Saved Resume";


    button.style.cssText = `

        all: initial;

        display: block;

        box-sizing: border-box;

        padding: 12px 18px;

        background: #111827;

        color: white;

        border: none;

        border-radius: 8px;

        font-family:
            Arial,
            sans-serif;

        font-size: 14px;

        font-weight: 600;

        line-height: 1.4;

        cursor: pointer;

        white-space: nowrap;

        box-shadow:
            0 4px 12px
            rgba(0, 0, 0, 0.25);
    `;


    /*
        Button click
    */

    button.addEventListener(
        "click",
        async () => {

            if (uploadInProgress) {
                return;
            }


            button.textContent =
                "⏳ Uploading...";


            const success =
                await useSavedResume();


            if (success) {

                button.textContent =
                    "✓ Resume Attached";

            }
            else {

                button.textContent =
                    "❌ Upload Failed";


                setTimeout(
                    () => {

                        button.textContent =
                            "⚡ Use Saved Resume";

                    },
                    2000
                );
            }
        }
    );


    shadow.appendChild(
        button
    );


    console.log(
        "✅ Resume One-Click UI created"
    );
}


/*
===========================================================
INITIALIZE
===========================================================
*/

function initialize() {
    createExtensionUI();
    detectResumeUploadUI();
    startUploadObserver();
    console.log("🚀 Resume One-Click initialized");
}

if (document.body) {
    initialize();
} else {
    window.addEventListener("DOMContentLoaded", initialize);
}