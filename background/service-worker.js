const DB_NAME = "resume-one-click";
const DB_VERSION = 1;
const STORE_NAME = "resumes";


console.log(
    "🔥 Resume One-Click service worker loaded"
);


/*
    Open IndexedDB.
*/
function openResumeDB() {

    return new Promise(
        (resolve, reject) => {

            const request =
                indexedDB.open(
                    DB_NAME,
                    DB_VERSION
                );


            request.onupgradeneeded = () => {

                const db =
                    request.result;


                if (
                    !db.objectStoreNames.contains(
                        STORE_NAME
                    )
                ) {

                    db.createObjectStore(
                        STORE_NAME
                    );
                }
            };


            request.onsuccess = () => {

                resolve(
                    request.result
                );
            };


            request.onerror = () => {

                reject(
                    request.error
                );
            };
        }
    );
}


/*
    Get saved resume.
*/
async function getResume() {

    const db =
        await openResumeDB();


    return new Promise(
        (resolve, reject) => {

            const transaction =
                db.transaction(
                    STORE_NAME,
                    "readonly"
                );


            const store =
                transaction.objectStore(
                    STORE_NAME
                );


            const request =
                store.get(
                    "default"
                );


            request.onsuccess = () => {

                resolve(
                    request.result || null
                );
            };


            request.onerror = () => {

                reject(
                    request.error
                );
            };
        }
    );
}


/*
    Convert File/Blob → Base64.
*/
function blobToBase64(blob) {

    return new Promise(
        (resolve, reject) => {

            const reader =
                new FileReader();


            reader.onload = () => {

                const result =
                    reader.result;


                /*
                    Example:

                    data:application/pdf;base64,
                    JVBERi0xLjQK...
                */

                const base64 =
                    result.split(",")[1];


                resolve(
                    base64
                );
            };


            reader.onerror = () => {

                reject(
                    reader.error
                );
            };


            reader.readAsDataURL(
                blob
            );
        }
    );
}


/*
    Listen for messages
    from content scripts.
*/
chrome.runtime.onMessage.addListener(
    (
        message,
        sender,
        sendResponse
    ) => {

        console.log(
            "📩 Message:",
            message
        );


        if (
            message.type !==
            "GET_RESUME"
        ) {

            return;
        }


        getResume()

            .then(
                async (resume) => {

                    if (!resume) {

                        sendResponse({
                            resume: null
                        });

                        return;
                    }


                    const base64 =
                        await blobToBase64(
                            resume
                        );


                    sendResponse({

                        resume: {

                            name:
                                resume.name,

                            type:
                                resume.type,

                            size:
                                resume.size,

                            lastModified:
                                resume.lastModified,

                            data:
                                base64
                        }

                    });

                }
            )

            .catch(
                (error) => {

                    console.error(
                        "❌ Failed to get resume:",
                        error
                    );


                    sendResponse({
                        resume: null
                    });
                }
            );


        /*
            Required because
            response is asynchronous.
        */

        return true;
    }
);