const resumeInput = document.getElementById("resumeInput");
const saveButton = document.getElementById("saveButton");
const deleteButton = document.getElementById("deleteButton");
const fileName = document.getElementById("fileName");
const fileSize = document.getElementById("fileSize");
const status = document.getElementById("status");


// Format bytes nicely.
function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}


// Display current saved resume.
async function loadSavedResume() {
    try {
        const resume = await getResume();
        if (!resume) {
            fileName.textContent = "No resume saved";
            fileSize.textContent = "";
            return;
        }
        fileName.textContent = resume.name;
        fileSize.textContent = formatFileSize(resume.size);
    } catch (error) {
        console.error(error);
        status.textContent = "Failed to load resume.";
    }
}


// Save selected resume.
saveButton.addEventListener("click", async () => {
    const file = resumeInput.files[0];
    if (!file) {
        status.textContent = "Please select a resume first.";
        return;
    }
    const allowedTypes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    const allowedExtensions = /\.(pdf|doc|docx)$/i;
    if (!allowedTypes.includes(file.type) && !allowedExtensions.test(file.name)) {
        status.textContent = "Please select a PDF, DOC, or DOCX file.";
        return;
    }
    try {
        await saveResume(file);
        fileName.textContent = file.name;
        fileSize.textContent = formatFileSize(file.size);
        status.textContent = "✓ Resume saved successfully.";
    } catch (error) {
        console.error(error);
        status.textContent = "❌ Failed to save resume.";
    }
});


// Delete resume.
deleteButton.addEventListener("click", async () => {
    try {
        await deleteResume();
        fileName.textContent = "No resume saved";
        fileSize.textContent = "";
        status.textContent = "Resume deleted.";
    } catch (error) {
        console.error(error);
        status.textContent = "Failed to delete resume.";
    }
});


// Load when popup opens.
loadSavedResume();