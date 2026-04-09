const dashboardList = document.getElementById("dashboardList");
const uploadForm = document.getElementById("uploadForm");
const uploadStatus = document.getElementById("uploadStatus");
const uploadTagsEditorRoot = document.getElementById("uploadTagsEditor");
const uploadTagsField = document.getElementById("uploadTags");
const uploadImageInput = document.getElementById("uploadImage");
const uploadPreviewList = document.getElementById("uploadPreviewList");
let draggedRow = null;
let dragGhost = null;
let dropLine = null;
let pointerOffsetX = 0;
let pointerOffsetY = 0;
let startOrder = [];
let pendingUploads = [];
let draggedUpload = null;
let uploadDragGhost = null;
let uploadDropMarker = null;
let uploadPointerOffsetX = 0;
let uploadPointerOffsetY = 0;
const saveTimers = new Map();

const setStatus = (message, isError = false) => {
    uploadStatus.textContent = message;
    uploadStatus.style.color = isError ? "#a00000" : "#000000";
};

const normalizeTag = (value) => value.trim().replace(/\s+/g, " ");

const uniqueTags = (values) => {
    const seen = new Set();
    const tags = [];

    values.forEach((value) => {
        const tag = normalizeTag(value);

        if (!tag) {
            return;
        }

        const key = tag.toLowerCase();

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        tags.push(tag);
    });

    return tags;
};

const normalizeArtwork = (item) => ({
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    image_urls: Array.isArray(item.image_urls)
        ? item.image_urls
        : Array.isArray(item.image_paths)
            ? item.image_paths
            : [item.image_url || item.image_path].filter(Boolean),
    image_url: item.image_url || item.image_path || (Array.isArray(item.image_paths) ? item.image_paths[0] : "")
});

const saveImage = async (id, payload) => {
    const response = await fetch(`/api/images/${id}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        throw new Error("Unable to save image.");
    }
};

const queueSave = (id, getPayload) => {
    if (saveTimers.has(id)) {
        clearTimeout(saveTimers.get(id));
    }

    const timer = window.setTimeout(async () => {
        saveTimers.delete(id);

        try {
            await saveImage(id, getPayload());
            setStatus("Changes saved.");
        } catch (error) {
            setStatus(error.message, true);
        }
    }, 350);

    saveTimers.set(id, timer);
};

const reorderImages = async (ids) => {
    const response = await fetch("/api/images/reorder", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ ids })
    });

    if (!response.ok) {
        throw new Error("Unable to reorder images.");
    }
};

const deleteImage = async (id) => {
    const response = await fetch(`/api/images/${id}`, {
        method: "DELETE"
    });

    if (!response.ok) {
        throw new Error("Unable to delete image.");
    }
};

const getCurrentOrder = () => Array.from(dashboardList.querySelectorAll(".dashboard-row")).map((row) => row.dataset.id);

const createTagChip = (tag, onRemove, removable = true) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag;

    if (!removable) {
        return chip;
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tag-chip-remove";
    remove.textContent = "×";
    remove.addEventListener("click", (event) => {
        event.stopPropagation();
        onRemove();
    });
    chip.appendChild(remove);

    return chip;
};

const createTagEditor = (initialTags, onChange) => {
    const editor = document.createElement("div");
    const list = document.createElement("div");
    const input = document.createElement("input");
    let tags = uniqueTags(initialTags);

    editor.className = "tag-editor";
    list.className = "tag-list tag-list-editor";
    input.className = "tag-input";
    input.type = "text";

    const emit = () => onChange(tags.slice());

    const render = () => {
        list.innerHTML = "";

        tags.forEach((tag) => {
            list.appendChild(createTagChip(tag, () => {
                tags = tags.filter((value) => value !== tag);
                render();
                emit();
            }));
        });
    };

    const commitInput = () => {
        const parsed = input.value.split(",").map(normalizeTag).filter(Boolean);

        if (!parsed.length) {
            input.value = "";
            return;
        }

        tags = uniqueTags([...tags, ...parsed]);
        input.value = "";
        render();
        emit();
    };

    input.addEventListener("input", () => {
        if (input.value.includes(",")) {
            commitInput();
        }
    });

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            commitInput();
        }

        if (event.key === "Backspace" && !input.value && tags.length) {
            tags = tags.slice(0, -1);
            render();
            emit();
        }
    });

    input.addEventListener("blur", commitInput);
    editor.addEventListener("click", () => input.focus());
    editor.append(list, input);
    render();

    return {
        element: editor,
        getTags: () => tags.slice(),
        reset: () => {
            tags = [];
            input.value = "";
            render();
            emit();
        }
    };
};

const createGallerySorter = (initialUrls, title, onChange) => {
    const list = document.createElement("div");
    let urls = initialUrls.slice();
    let draggedItem = null;
    let dragGhost = null;
    let dropMarker = null;
    let pointerX = 0;
    let pointerY = 0;

    list.className = "dashboard-gallery-list";

    const cleanup = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);

        if (dragGhost) {
            dragGhost.remove();
            dragGhost = null;
        }

        if (dropMarker) {
            dropMarker.remove();
            dropMarker = null;
        }

        if (draggedItem) {
            draggedItem.classList.remove("is-sorting");
            draggedItem = null;
        }
    };

    const moveGhost = (event) => {
        if (!dragGhost) {
            return;
        }

        dragGhost.style.left = `${event.clientX - pointerX}px`;
        dragGhost.style.top = `${event.clientY - pointerY}px`;
    };

    const placeMarker = (event) => {
        const items = Array.from(list.querySelectorAll(".dashboard-gallery-item")).filter((item) => item !== draggedItem);

        if (!items.length) {
            list.appendChild(dropMarker);
            return;
        }

        for (const item of items) {
            const bounds = item.getBoundingClientRect();
            const midpoint = bounds.top + bounds.height / 2;

            if (event.clientY < midpoint) {
                list.insertBefore(dropMarker, item);
                return;
            }
        }

        list.appendChild(dropMarker);
    };

    function handleMove(event) {
        moveGhost(event);
        placeMarker(event);
    }

    function handleUp() {
        if (!draggedItem) {
            return;
        }

        const item = draggedItem;

        if (dropMarker && dropMarker.parentNode) {
            dropMarker.replaceWith(item);
        }

        urls = Array.from(list.querySelectorAll(".dashboard-gallery-item")).map((entry) => entry.dataset.url);
        cleanup();
        render();
        onChange(urls.slice());
    }

    const startDrag = (event) => {
        if (event.button !== 0 || draggedItem) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const item = event.currentTarget;
        const bounds = item.getBoundingClientRect();

        draggedItem = item;
        pointerX = event.clientX - bounds.left;
        pointerY = event.clientY - bounds.top;

        dragGhost = item.cloneNode(true);
        dragGhost.className = "dashboard-gallery-item dashboard-gallery-ghost";
        dragGhost.style.width = `${bounds.width}px`;
        dragGhost.style.height = `${bounds.height}px`;
        dragGhost.style.left = `${bounds.left}px`;
        dragGhost.style.top = `${bounds.top}px`;

        dropMarker = document.createElement("div");
        dropMarker.className = "dashboard-gallery-drop-marker";

        item.classList.add("is-sorting");
        document.body.appendChild(dragGhost);
        placeMarker(event);
        moveGhost(event);

        window.addEventListener("pointermove", handleMove);
        window.addEventListener("pointerup", handleUp, { once: true });
    };

    const render = () => {
        list.innerHTML = "";

        urls.forEach((url) => {
            const item = document.createElement("div");
            const image = document.createElement("img");

            item.className = "dashboard-gallery-item";
            item.dataset.url = url;
            image.src = url;
            image.alt = title;
            image.draggable = false;
            item.appendChild(image);
            item.addEventListener("pointerdown", startDrag);
            list.appendChild(item);
        });
    };

    render();

    return {
        element: list,
        getUrls: () => urls.slice()
    };
};

const renderUploadPreviews = () => {
    uploadPreviewList.innerHTML = "";

    pendingUploads.forEach((entry, index) => {
        const item = document.createElement("div");
        const image = document.createElement("img");
        const remove = document.createElement("button");

        item.className = "upload-preview-item";
        item.dataset.index = String(index);
        image.src = entry.previewUrl;
        image.alt = entry.file.name;
        image.draggable = false;
        remove.type = "button";
        remove.className = "upload-preview-remove";
        remove.textContent = "×";
        remove.addEventListener("click", () => {
            URL.revokeObjectURL(entry.previewUrl);
            pendingUploads.splice(index, 1);
            renderUploadPreviews();
        });
        item.addEventListener("pointerdown", startUploadDrag);

        item.append(image, remove);

        uploadPreviewList.appendChild(item);
    });

    const addButton = document.createElement("button");
    const plus = document.createElement("span");

    addButton.type = "button";
    addButton.className = "upload-preview-add";
    addButton.setAttribute("aria-label", "Add images");
    addButton.addEventListener("click", () => {
        uploadImageInput.click();
    });
    plus.textContent = "+";
    addButton.appendChild(plus);
    uploadPreviewList.appendChild(addButton);
};

const cleanupUploadDrag = () => {
    window.removeEventListener("pointermove", handleUploadPointerMove);
    window.removeEventListener("pointerup", handleUploadPointerUp);
    document.body.classList.remove("upload-preview-sorting");

    if (uploadDragGhost) {
        uploadDragGhost.remove();
        uploadDragGhost = null;
    }

    if (uploadDropMarker) {
        uploadDropMarker.remove();
        uploadDropMarker = null;
    }

    if (draggedUpload) {
        draggedUpload.classList.remove("is-sorting");
        draggedUpload = null;
    }
};

const moveUploadGhost = (event) => {
    if (!uploadDragGhost) {
        return;
    }

    uploadDragGhost.style.left = `${event.clientX - uploadPointerOffsetX}px`;
    uploadDragGhost.style.top = `${event.clientY - uploadPointerOffsetY}px`;
};

const placeUploadMarker = (event) => {
    const items = Array.from(uploadPreviewList.querySelectorAll(".upload-preview-item")).filter((item) => item !== draggedUpload);

    if (!items.length) {
        uploadPreviewList.insertBefore(uploadDropMarker, uploadPreviewList.querySelector(".upload-preview-add"));
        return;
    }

    for (const item of items) {
        const bounds = item.getBoundingClientRect();
        const midpoint = bounds.left + bounds.width / 2;

        if (event.clientX < midpoint) {
            uploadPreviewList.insertBefore(uploadDropMarker, item);
            return;
        }
    }

    uploadPreviewList.insertBefore(uploadDropMarker, uploadPreviewList.querySelector(".upload-preview-add"));
};

function handleUploadPointerMove(event) {
    if (!draggedUpload) {
        return;
    }

    moveUploadGhost(event);
    placeUploadMarker(event);
}

function handleUploadPointerUp() {
    if (!draggedUpload) {
        return;
    }

    const item = draggedUpload;

    if (uploadDropMarker && uploadDropMarker.parentNode) {
        uploadDropMarker.replaceWith(item);
    }

    const nextOrder = Array.from(uploadPreviewList.querySelectorAll(".upload-preview-item")).map((preview) => {
        const index = Number(preview.dataset.index);
        return pendingUploads[index];
    });

    cleanupUploadDrag();
    pendingUploads = nextOrder;
    renderUploadPreviews();
}

const startUploadDrag = (event) => {
    if (event.button !== 0 || draggedUpload || event.target.closest(".upload-preview-remove")) {
        return;
    }

    event.preventDefault();

    const item = event.currentTarget;
    const bounds = item.getBoundingClientRect();

    draggedUpload = item;
    uploadPointerOffsetX = event.clientX - bounds.left;
    uploadPointerOffsetY = event.clientY - bounds.top;

    uploadDragGhost = item.cloneNode(true);
    uploadDragGhost.className = "upload-preview-item upload-preview-ghost";
    uploadDragGhost.style.width = `${bounds.width}px`;
    uploadDragGhost.style.left = `${bounds.left}px`;
    uploadDragGhost.style.top = `${bounds.top}px`;

    uploadDropMarker = document.createElement("div");
    uploadDropMarker.className = "upload-preview-drop-marker";

    item.classList.add("is-sorting");
    document.body.classList.add("upload-preview-sorting");
    document.body.appendChild(uploadDragGhost);

    placeUploadMarker(event);
    moveUploadGhost(event);

    window.addEventListener("pointermove", handleUploadPointerMove);
    window.addEventListener("pointerup", handleUploadPointerUp, { once: true });
};

const clearPendingUploads = () => {
    pendingUploads.forEach((entry) => {
        URL.revokeObjectURL(entry.previewUrl);
    });
    pendingUploads = [];
    renderUploadPreviews();
};

const cleanupDrag = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    document.body.classList.remove("dashboard-dragging");

    if (dragGhost) {
        dragGhost.remove();
        dragGhost = null;
    }

    if (dropLine) {
        dropLine.remove();
        dropLine = null;
    }

    if (draggedRow) {
        draggedRow.classList.remove("is-sorting");
        draggedRow = null;
    }
};

const moveGhost = (event) => {
    if (!dragGhost) {
        return;
    }

    dragGhost.style.left = `${event.clientX - pointerOffsetX}px`;
    dragGhost.style.top = `${event.clientY - pointerOffsetY}px`;
};

const placeDropLine = (event) => {
    const rows = Array.from(dashboardList.querySelectorAll(".dashboard-row")).filter((row) => row !== draggedRow);

    if (!rows.length) {
        dashboardList.appendChild(dropLine);
        return;
    }

    for (const row of rows) {
        const bounds = row.getBoundingClientRect();
        const midpoint = bounds.top + bounds.height / 2;

        if (event.clientY < midpoint) {
            dashboardList.insertBefore(dropLine, row);
            return;
        }
    }

    dashboardList.appendChild(dropLine);
};

function handlePointerMove(event) {
    if (!draggedRow) {
        return;
    }

    moveGhost(event);
    placeDropLine(event);
}

async function handlePointerUp() {
    if (!draggedRow) {
        return;
    }

    const row = draggedRow;
    const previousOrder = startOrder.join(",");

    if (dropLine && dropLine.parentNode) {
        dropLine.replaceWith(row);
    }

    row.classList.remove("is-sorting");

    const nextOrder = getCurrentOrder().join(",");
    cleanupDrag();

    if (previousOrder === nextOrder) {
        return;
    }

    try {
        await reorderImages(nextOrder.split(","));
    } catch (error) {
        await loadDashboard();
    }
};

const startDrag = (event) => {
    if (draggedRow) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const trigger = event.currentTarget;
    const row = trigger.closest(".dashboard-row");
    const bounds = row.getBoundingClientRect();

    draggedRow = row;
    startOrder = getCurrentOrder();
    pointerOffsetX = event.clientX - bounds.left;
    pointerOffsetY = event.clientY - bounds.top;

    dragGhost = row.cloneNode(true);
    dragGhost.className = "dashboard-row dashboard-drag-ghost";
    dragGhost.style.width = `${bounds.width}px`;
    dragGhost.style.left = `${bounds.left}px`;
    dragGhost.style.top = `${bounds.top}px`;

    dropLine = document.createElement("div");
    dropLine.className = "dashboard-drop-line";

    row.classList.add("is-sorting");
    document.body.classList.add("dashboard-dragging");
    document.body.appendChild(dragGhost);

    placeDropLine(event);
    moveGhost(event);

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
};

const startDragFromRow = (event) => {
    if (draggedRow || event.button !== 0) {
        return;
    }

    const target = event.target;

    if (target.closest(".dashboard-fields") || target.closest(".dashboard-remove") || target.closest(".dashboard-gallery-list")) {
        return;
    }

    startDrag(event);
};

const createRow = (item) => {
    const artwork = normalizeArtwork(item);
    const row = document.createElement("article");
    const handle = document.createElement("button");
    const thumb = document.createElement("div");
    const fields = document.createElement("div");
    const titleField = document.createElement("div");
    const titleLabel = document.createElement("label");
    const titleInput = document.createElement("input");
    const tagsField = document.createElement("div");
    const tagsLabel = document.createElement("label");
    const tagsHint = document.createElement("p");
    const descriptionField = document.createElement("div");
    const descriptionLabel = document.createElement("label");
    const descriptionInput = document.createElement("textarea");
    const deleteButton = document.createElement("button");

    row.className = "dashboard-row";
    row.dataset.id = artwork.id;
    thumb.className = "dashboard-thumb";
    fields.className = "dashboard-fields";
    titleField.className = "field";
    tagsField.className = "field";
    descriptionField.className = "field";
    handle.className = "dashboard-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", "Reorder image");
    handle.textContent = "≡";
    deleteButton.className = "dashboard-remove";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", "Remove image");
    deleteButton.textContent = "×";

    let gallerySorter = null;

    if (artwork.image_urls.length > 1) {
        thumb.classList.add("dashboard-thumb-gallery");
        gallerySorter = createGallerySorter(artwork.image_urls, artwork.title, scheduleSave);
        thumb.appendChild(gallerySorter.element);
    } else {
        const thumbImage = document.createElement("img");
        thumbImage.src = artwork.image_url;
        thumbImage.alt = artwork.title;
        thumbImage.draggable = false;
        thumb.appendChild(thumbImage);
    }

    titleLabel.textContent = "Title";
    titleInput.value = artwork.title;
    titleInput.name = `title-${artwork.id}`;

    tagsLabel.textContent = "Tags";
    tagsHint.className = "field-hint";
    tagsHint.textContent = "Comma separated.";

    descriptionLabel.textContent = "Description";
    descriptionInput.value = artwork.description || "";
    descriptionInput.name = `description-${artwork.id}`;

    const tagEditor = createTagEditor(artwork.tags || [], scheduleSave);

    function scheduleSave() {
        queueSave(artwork.id, () => ({
            title: titleInput.value.trim(),
            description: descriptionInput.value.trim(),
            tags: tagEditor.getTags(),
            image_urls: gallerySorter ? gallerySorter.getUrls() : artwork.image_urls
        }));
    }

    titleInput.addEventListener("input", scheduleSave);
    descriptionInput.addEventListener("input", scheduleSave);

    deleteButton.addEventListener("click", async () => {
        const confirmed = window.confirm(`Remove "${artwork.title}"?`);

        if (!confirmed) {
            return;
        }

        try {
            await deleteImage(artwork.id);
            setStatus("Image removed.");
            await loadDashboard();
        } catch (error) {
            setStatus(error.message, true);
        }
    });

    deleteButton.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
    });

    handle.addEventListener("pointerdown", startDrag);
    row.addEventListener("pointerdown", startDragFromRow);

    titleField.append(titleLabel, titleInput);
    tagsField.append(tagsLabel, tagEditor.element, tagsHint);
    descriptionField.append(descriptionLabel, descriptionInput);
    fields.append(titleField, tagsField, descriptionField);
    row.append(handle, thumb, fields, deleteButton);

    return row;
};

const renderDashboard = (items) => {
    dashboardList.innerHTML = "";

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No drawings yet.";
        dashboardList.appendChild(empty);
        return;
    }

    items.forEach((item) => {
        dashboardList.appendChild(createRow(item));
    });
};

const loadDashboard = async () => {
    const response = await fetch("/api/images");
    const items = await response.json();
    renderDashboard(items);
};

const uploadTagEditor = createTagEditor([], (tags) => {
    uploadTagsField.value = JSON.stringify(tags);
});
uploadTagsEditorRoot.replaceWith(uploadTagEditor.element);
uploadTagsField.value = "[]";

uploadImageInput.addEventListener("change", () => {
    const files = Array.from(uploadImageInput.files || []);

    files.forEach((file) => {
        pendingUploads.push({
            file,
            previewUrl: URL.createObjectURL(file)
        });
    });

    uploadImageInput.value = "";
    renderUploadPreviews();
});

uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!pendingUploads.length) {
        setStatus("Add at least one image.", true);
        return;
    }

    const formData = new FormData();
    formData.append("title", uploadForm.elements.title.value);
    formData.append("description", uploadForm.elements.description.value);
    formData.append("tags", uploadTagsField.value);
    pendingUploads.forEach((entry) => {
        formData.append("image", entry.file);
    });

    try {
        const response = await fetch("/api/images", {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error("Unable to upload image.");
        }

        uploadForm.reset();
        uploadTagEditor.reset();
        clearPendingUploads();
        setStatus("Image uploaded.");
        await loadDashboard();
    } catch (error) {
        setStatus(error.message, true);
    }
});

renderUploadPreviews();
loadDashboard();
