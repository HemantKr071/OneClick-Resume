const resumeInput = document.getElementById("resumeInput");
const addButton = document.getElementById("addButton");
const resumeList = document.getElementById("resumeList");
const statusEl = document.getElementById("status");


const ALLOWED_TYPES = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
];

const ALLOWED_EXTENSIONS = /\.(pdf|doc|docx)$/i;


// Format bytes nicely.
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(timestamp) {
    try {
        return new Date(timestamp).toLocaleDateString();
    } catch {
        return "";
    }
}

function setStatus(message) {
    statusEl.textContent = message;
}


/*
-----------------------------------------------------
Render the saved resumes.

Default resume is marked with ⭐ and highlighted.
Each row offers [Set Default] and [Delete].
-----------------------------------------------------
*/

async function renderResumeList() {
    const { resumes, defaultResumeId } = await getResumes();

    resumeList.innerHTML = "";

    if (!resumes.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No resumes saved yet. Add your first one below.";
        resumeList.appendChild(empty);
        return;
    }

    for (const meta of resumes) {
        const isDefault = meta.id === defaultResumeId;

        const row = document.createElement("div");
        row.className =
            "resume-row" + (isDefault ? " is-default" : "");

        const main = document.createElement("div");
        main.className = "row-main";

        const name = document.createElement("div");
        name.className = "row-name";
        name.textContent = (isDefault ? "⭐ " : "") + meta.name;
        name.title = meta.name;

        const metaLine = document.createElement("div");
        metaLine.className = "row-meta";
        metaLine.textContent =
            `${formatFileSize(meta.size)} · ${formatDate(meta.lastModified)}`;

        main.append(name, metaLine);

        const actions = document.createElement("div");
        actions.className = "row-actions";

        const defaultButton = document.createElement("button");
        defaultButton.className =
            "action-button" +
            (isDefault ? " default-active" : "");
        defaultButton.textContent = isDefault ? "⭐ Default" : "Set Default";
        defaultButton.disabled = isDefault;
        defaultButton.addEventListener("click", async () => {
            await handleSetDefault(meta.id);
        });

        const deleteButton = document.createElement("button");
        deleteButton.className = "action-button delete";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", async () => {
            await handleDelete(meta.id, meta.name);
        });

        actions.append(defaultButton, deleteButton);
        row.append(main, actions);
        resumeList.appendChild(row);
    }
}


/*
-----------------------------------------------------
Actions.
-----------------------------------------------------
*/

async function handleSetDefault(id) {
    try {
        await setDefaultResumeId(id);
        setStatus("✓ Default updated.");
        await renderResumeList();
    } catch (error) {
        console.error(error);
        setStatus(
            error.message === "RESUME_NOT_FOUND"
                ? "That resume no longer exists."
                : "❌ Failed to set default."
        );
    }
}

async function handleDelete(id, name) {
    if (!confirm(`Delete "${name}"?`)) return;

    try {
        const result = await deleteResumeRecord(id);

        if (result.defaultResumeId) {
            setStatus("✓ Deleted. Another resume is now default.");
        } else {
            setStatus("✓ Deleted. No resumes left.");
        }

        await renderResumeList();
    } catch (error) {
        console.error(error);
        setStatus("❌ Failed to delete resume.");
    }
}

function validateFile(file) {
    if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.test(file.name)) {
        return `"${file.name}" is not a PDF, DOC, or DOCX file.`;
    }
    if (file.size > MAX_RESUME_BYTES) {
        return `"${file.name}" is too large (max 10 MB).`;
    }
    if (file.size === 0) {
        return `"${file.name}" is empty.`;
    }
    return null;
}

async function addFiles(files) {
    let savedCount = 0;

    for (const file of files) {
        const validationError = validateFile(file);

        if (validationError) {
            setStatus(`❌ ${validationError}`);
            continue;
        }

        try {
            const data = await blobToBase64(file);

            await saveResumeRecord({
                name: file.name,
                type: file.type,
                size: file.size,
                lastModified: file.lastModified,
                data
            });

            savedCount += 1;
            console.log("✓ Saved:", file.name);
        } catch (error) {
            console.error(error);

            if (error.message === "DUPLICATE_NAME") {
                setStatus(`❌ "${file.name}" is already saved.`);
            } else if (error.message === "RESUME_TOO_LARGE") {
                setStatus(`❌ "${file.name}" is too large.`);
            } else {
                setStatus(`❌ Failed to save "${file.name}".`);
            }
        }
    }

    if (savedCount > 0) {
        setStatus(
            `✓ ${savedCount} resume${savedCount > 1 ? "s" : ""} saved.`
        );
        await renderResumeList();
    }
}


/*
-----------------------------------------------------
Wire up controls.
-----------------------------------------------------
*/

addButton.addEventListener("click", () => resumeInput.click());

resumeInput.addEventListener("change", async () => {
    const files = [...resumeInput.files];
    resumeInput.value = ""; // allow re-selecting the same file

    if (!files.length) return;

    addButton.disabled = true;
    setStatus("Saving…");

    await addFiles(files);

    addButton.disabled = false;
});


// Load when popup opens.
renderResumeList()
    .catch((error) => {
        console.error(error);
        setStatus("Failed to load resumes.");
    });
