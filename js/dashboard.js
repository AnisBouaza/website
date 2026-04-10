// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const normalizeArtwork = (item) => ({
    ...item,
    tags: Array.isArray(item.tags) ? item.tags : [],
    image_urls: Array.isArray(item.image_urls)
        ? item.image_urls
        : Array.isArray(item.image_paths)
            ? item.image_paths
            : [item.image_url || item.image_path].filter(Boolean),
    image_url: item.image_url || item.image_path || (Array.isArray(item.image_paths) ? item.image_paths[0] : ""),
});

const normalizeTag = (value) => value.trim().replace(/\s+/g, " ");

const uniqueTags = (values) => {
    const seen = new Set();
    const tags = [];

    values.forEach((value) => {
        const tag = normalizeTag(value);
        if (!tag) return;
        const key = tag.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        tags.push(tag);
    });

    return tags;
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const dashboardList = document.getElementById("dashboardList");
const uploadForm = document.getElementById("uploadForm");
const uploadStatus = document.getElementById("uploadStatus");
const uploadTagsEditorRoot = document.getElementById("uploadTagsEditor");
const uploadTagsField = document.getElementById("uploadTags");
const uploadImageInput = document.getElementById("uploadImage");
const uploadPreviewList = document.getElementById("uploadPreviewList");
const uploadTagPickerRoot = document.getElementById("uploadTagPicker");
const tagLibraryInput = document.getElementById("tagLibraryInput");
const tagLibraryAddButton = document.getElementById("tagLibraryAdd");
const tagLibraryListEl = document.getElementById("tagLibraryList");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pendingUploads = [];
let tagLibrary = [];
const saveTimers = new Map();

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const setStatus = (message, isError = false) => {
    uploadStatus.textContent = message;
    uploadStatus.style.color = isError ? "#a00000" : "#000000";
};

// ---------------------------------------------------------------------------
// Unified drag-and-drop factory
// ---------------------------------------------------------------------------
// createDragSorter({ container, itemSelector, axis, ghostClass, markerClass,
//   sortingClass, onReorder, excludeFromDrag, insertBeforeSelector })
//
// Returns { cleanup }

const createDragSorter = (options) => {
    const {
        container,
        itemSelector,
        axis = "vertical",           // "vertical" | "horizontal"
        ghostClass,
        markerClass,
        sortingClass = "is-sorting",
        bodyClass = null,
        onReorder,
        excludeFromDrag = null,      // selector string to skip drag start
        insertBeforeSelector = null,  // for horizontal: insert marker before this (e.g. add-button)
    } = options;

    let draggedItem = null;
    let ghost = null;
    let marker = null;
    let offsetX = 0;
    let offsetY = 0;

    const getItems = () =>
        Array.from(container.querySelectorAll(itemSelector)).filter((el) => el !== draggedItem);

    const cleanup = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (bodyClass) document.body.classList.remove(bodyClass);
        if (ghost) { ghost.remove(); ghost = null; }
        if (marker) { marker.remove(); marker = null; }
        if (draggedItem) { draggedItem.classList.remove(sortingClass); draggedItem = null; }
    };

    const moveGhost = (event) => {
        if (!ghost) return;
        ghost.style.left = `${event.clientX - offsetX}px`;
        ghost.style.top = `${event.clientY - offsetY}px`;
    };

    const placeMarker = (event) => {
        const items = getItems();

        if (!items.length) {
            const anchor = insertBeforeSelector ? container.querySelector(insertBeforeSelector) : null;
            anchor ? container.insertBefore(marker, anchor) : container.appendChild(marker);
            return;
        }

        for (const item of items) {
            const bounds = item.getBoundingClientRect();
            const mid = axis === "horizontal"
                ? bounds.left + bounds.width / 2
                : bounds.top + bounds.height / 2;
            const pos = axis === "horizontal" ? event.clientX : event.clientY;

            if (pos < mid) {
                container.insertBefore(marker, item);
                return;
            }
        }

        const anchor = insertBeforeSelector ? container.querySelector(insertBeforeSelector) : null;
        anchor ? container.insertBefore(marker, anchor) : container.appendChild(marker);
    };

    function onMove(event) {
        if (!draggedItem) return;
        moveGhost(event);
        placeMarker(event);
    }

    function onUp() {
        if (!draggedItem) return;
        const item = draggedItem;
        if (marker && marker.parentNode) marker.replaceWith(item);
        const ordered = Array.from(container.querySelectorAll(itemSelector));
        cleanup();
        onReorder(ordered);
    }

    const startDrag = (event, item) => {
        if (event.button !== 0 || draggedItem) return;
        if (excludeFromDrag && event.target.closest(excludeFromDrag)) return;

        event.preventDefault();
        event.stopPropagation();

        const bounds = item.getBoundingClientRect();
        draggedItem = item;
        offsetX = event.clientX - bounds.left;
        offsetY = event.clientY - bounds.top;

        ghost = item.cloneNode(true);
        ghost.className = `${item.className} ${ghostClass}`;
        ghost.style.width = `${bounds.width}px`;
        if (axis === "vertical") ghost.style.height = `${bounds.height}px`;
        ghost.style.left = `${bounds.left}px`;
        ghost.style.top = `${bounds.top}px`;
        ghost.style.position = "fixed";
        ghost.style.margin = "0";
        ghost.style.zIndex = "1000";
        ghost.style.pointerEvents = "none";

        marker = document.createElement("div");
        marker.className = markerClass;

        item.classList.add(sortingClass);
        if (bodyClass) document.body.classList.add(bodyClass);
        document.body.appendChild(ghost);
        placeMarker(event);
        moveGhost(event);

        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
    };

    return { startDrag, cleanup };
};

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

const saveImage = async (id, payload) => {
    const response = await fetch(`/api/images/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error("Unable to save image.");
};

const queueSave = (id, getPayload) => {
    if (saveTimers.has(id)) clearTimeout(saveTimers.get(id));

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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
    });
    if (!response.ok) throw new Error("Unable to reorder images.");
};

const deleteImage = async (id) => {
    const response = await fetch(`/api/images/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Unable to delete image.");
};

const getCurrentOrder = () =>
    Array.from(dashboardList.querySelectorAll(".dashboard-row")).map((row) => row.dataset.id);

// ---------------------------------------------------------------------------
// Tag library API
// ---------------------------------------------------------------------------

const fetchTagLibrary = async () => {
    try {
        const response = await fetch("/api/tags");
        if (response.ok) tagLibrary = await response.json();
    } catch {
        tagLibrary = [];
    }
};

const apiAddTag = async (name) => {
    const response = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Unable to add tag.");
    }
    tagLibrary = await response.json();
};

const apiDeleteTag = async (name) => {
    const response = await fetch(`/api/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Unable to delete tag.");
    tagLibrary = await response.json();
};

// ---------------------------------------------------------------------------
// Tag library UI
// ---------------------------------------------------------------------------

const renderTagLibrary = () => {
    tagLibraryListEl.innerHTML = "";

    if (!tagLibrary.length) {
        const hint = document.createElement("p");
        hint.className = "field-hint";
        hint.textContent = "No tags yet. Create some above.";
        tagLibraryListEl.appendChild(hint);
        return;
    }

    tagLibrary.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "tag-chip-remove";
        remove.textContent = "×";
        remove.addEventListener("click", async () => {
            try {
                await apiDeleteTag(tag);
                renderTagLibrary();
                renderAllTagPickers();
            } catch (error) {
                setStatus(error.message, true);
            }
        });

        chip.appendChild(remove);
        tagLibraryListEl.appendChild(chip);
    });
};

tagLibraryAddButton.addEventListener("click", async () => {
    const name = tagLibraryInput.value.trim();
    if (!name) return;

    try {
        await apiAddTag(name);
        tagLibraryInput.value = "";
        renderTagLibrary();
        renderAllTagPickers();
    } catch (error) {
        setStatus(error.message, true);
    }
});

tagLibraryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        tagLibraryAddButton.click();
    }
});

// ---------------------------------------------------------------------------
// Tag picker (clickable library tags for quick assignment)
// ---------------------------------------------------------------------------
// Keeps a registry so we can re-render all pickers when the library changes.

const tagPickerRegistry = [];

const renderAllTagPickers = () => {
    tagPickerRegistry.forEach((entry) => entry.render());
};

const createTagPicker = (container, getSelectedTags, onToggle) => {
    const render = () => {
        container.innerHTML = "";

        if (!tagLibrary.length) return;

        const selected = new Set(getSelectedTags().map((t) => t.toLowerCase()));

        tagLibrary.forEach((tag) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "tag-picker-chip" + (selected.has(tag.toLowerCase()) ? " is-selected" : "");
            chip.textContent = tag;
            chip.addEventListener("click", () => {
                onToggle(tag);
                render();
            });
            container.appendChild(chip);
        });
    };

    const entry = { render };
    tagPickerRegistry.push(entry);
    render();

    return { render, destroy: () => {
        const idx = tagPickerRegistry.indexOf(entry);
        if (idx !== -1) tagPickerRegistry.splice(idx, 1);
    }};
};

// ---------------------------------------------------------------------------
// Tag editor (inline typing + chips)
// ---------------------------------------------------------------------------

const createTagChip = (tag, onRemove) => {
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.textContent = tag;

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
    input.placeholder = "Or type custom tags…";

    const emit = () => onChange(tags.slice());

    const render = () => {
        list.innerHTML = "";
        tags.forEach((tag) => {
            list.appendChild(createTagChip(tag, () => {
                tags = tags.filter((v) => v !== tag);
                render();
                emit();
            }));
        });
    };

    const commitInput = () => {
        const parsed = input.value.split(",").map(normalizeTag).filter(Boolean);
        if (!parsed.length) { input.value = ""; return; }
        tags = uniqueTags([...tags, ...parsed]);
        input.value = "";
        render();
        emit();
    };

    const addTag = (tag) => {
        const key = tag.toLowerCase();
        if (tags.some((t) => t.toLowerCase() === key)) {
            // Remove if already present (toggle behavior)
            tags = tags.filter((t) => t.toLowerCase() !== key);
        } else {
            tags = uniqueTags([...tags, tag]);
        }
        render();
        emit();
    };

    input.addEventListener("input", () => { if (input.value.includes(",")) commitInput(); });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); commitInput(); }
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
        addTag,
        reset: () => { tags = []; input.value = ""; render(); emit(); },
    };
};

// ---------------------------------------------------------------------------
// Gallery image sorter (within a dashboard row)
// ---------------------------------------------------------------------------

const createGallerySorter = (initialUrls, title, onChange) => {
    const list = document.createElement("div");
    let urls = initialUrls.slice();
    list.className = "dashboard-gallery-list";

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
            item.addEventListener("pointerdown", (event) => sorter.startDrag(event, item));
            list.appendChild(item);
        });
    };

    const sorter = createDragSorter({
        container: list,
        itemSelector: ".dashboard-gallery-item",
        axis: "vertical",
        ghostClass: "dashboard-gallery-ghost",
        markerClass: "dashboard-gallery-drop-marker",
        onReorder: (ordered) => {
            urls = ordered.map((el) => el.dataset.url);
            render();
            onChange(urls.slice());
        },
    });

    render();

    return { element: list, getUrls: () => urls.slice() };
};

// ---------------------------------------------------------------------------
// Upload preview list with drag reorder
// ---------------------------------------------------------------------------

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

        item.addEventListener("pointerdown", (event) => {
            if (event.target.closest(".upload-preview-remove")) return;
            uploadSorter.startDrag(event, item);
        });

        item.append(image, remove);
        uploadPreviewList.appendChild(item);
    });

    const addButton = document.createElement("button");
    const plus = document.createElement("span");
    addButton.type = "button";
    addButton.className = "upload-preview-add";
    addButton.setAttribute("aria-label", "Add images");
    addButton.addEventListener("click", () => uploadImageInput.click());
    plus.textContent = "+";
    addButton.appendChild(plus);
    uploadPreviewList.appendChild(addButton);
};

const uploadSorter = createDragSorter({
    container: uploadPreviewList,
    itemSelector: ".upload-preview-item",
    axis: "horizontal",
    ghostClass: "upload-preview-ghost",
    markerClass: "upload-preview-drop-marker",
    bodyClass: "upload-preview-sorting",
    insertBeforeSelector: ".upload-preview-add",
    onReorder: (ordered) => {
        const nextOrder = ordered.map((el) => pendingUploads[Number(el.dataset.index)]);
        pendingUploads = nextOrder;
        renderUploadPreviews();
    },
});

const clearPendingUploads = () => {
    pendingUploads.forEach((entry) => URL.revokeObjectURL(entry.previewUrl));
    pendingUploads = [];
    renderUploadPreviews();
};

// ---------------------------------------------------------------------------
// Dashboard row drag reorder
// ---------------------------------------------------------------------------

const rowSorter = createDragSorter({
    container: dashboardList,
    itemSelector: ".dashboard-row",
    axis: "vertical",
    ghostClass: "dashboard-drag-ghost",
    markerClass: "dashboard-drop-line",
    bodyClass: "dashboard-dragging",
    excludeFromDrag: ".dashboard-fields, .dashboard-remove, .dashboard-gallery-list",
    onReorder: async (ordered) => {
        const ids = ordered.map((el) => el.dataset.id);
        try {
            await reorderImages(ids);
        } catch {
            await loadDashboard();
        }
    },
});

// ---------------------------------------------------------------------------
// Dashboard row creation
// ---------------------------------------------------------------------------

const createRow = (item) => {
    const artwork = normalizeArtwork(item);

    // Elements
    const row = document.createElement("article");
    const handle = document.createElement("button");
    const thumb = document.createElement("div");
    const fields = document.createElement("div");
    const deleteButton = document.createElement("button");

    row.className = "dashboard-row";
    row.dataset.id = artwork.id;
    handle.className = "dashboard-handle";
    handle.type = "button";
    handle.setAttribute("aria-label", "Reorder image");
    handle.textContent = "≡";
    thumb.className = "dashboard-thumb";
    fields.className = "dashboard-fields";
    deleteButton.className = "dashboard-remove";
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", "Remove image");
    deleteButton.textContent = "×";

    // Thumbnail / gallery sorter
    let gallerySorter = null;

    if (artwork.image_urls.length > 1) {
        thumb.classList.add("dashboard-thumb-gallery");
        gallerySorter = createGallerySorter(artwork.image_urls, artwork.title, scheduleSave);
        thumb.appendChild(gallerySorter.element);
    } else {
        const img = document.createElement("img");
        img.src = artwork.image_url;
        img.alt = artwork.title;
        img.draggable = false;
        thumb.appendChild(img);
    }

    // Fields
    const titleInput = createField("Title", "input", artwork.title);
    const descriptionInput = createField("Description", "textarea", artwork.description || "");

    // Tag editor + picker for this row
    const tagEditor = createTagEditor(artwork.tags || [], scheduleSave);
    const tagPickerContainer = document.createElement("div");
    tagPickerContainer.className = "tag-picker";
    const picker = createTagPicker(tagPickerContainer, tagEditor.getTags, (tag) => {
        tagEditor.addTag(tag);
        picker.render();
        scheduleSave();
    });

    const tagsField = document.createElement("div");
    tagsField.className = "field";
    const tagsLabel = document.createElement("label");
    tagsLabel.textContent = "Tags";
    tagsField.append(tagsLabel, tagPickerContainer, tagEditor.element);

    function scheduleSave() {
        queueSave(artwork.id, () => ({
            title: titleInput.value.trim(),
            description: descriptionInput.value.trim(),
            tags: tagEditor.getTags(),
            image_urls: gallerySorter ? gallerySorter.getUrls() : artwork.image_urls,
        }));
    }

    titleInput.addEventListener("input", scheduleSave);
    descriptionInput.addEventListener("input", scheduleSave);

    // Delete
    deleteButton.addEventListener("click", async () => {
        if (!window.confirm(`Remove "${artwork.title}"?`)) return;
        try {
            await deleteImage(artwork.id);
            setStatus("Image removed.");
            await loadDashboard();
        } catch (error) {
            setStatus(error.message, true);
        }
    });
    deleteButton.addEventListener("pointerdown", (event) => event.stopPropagation());

    // Drag
    handle.addEventListener("pointerdown", (event) => rowSorter.startDrag(event, row));
    row.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        if (event.target.closest(".dashboard-fields, .dashboard-remove, .dashboard-gallery-list")) return;
        rowSorter.startDrag(event, row);
    });

    // Assemble
    const titleField = wrapField("Title", titleInput);
    const descField = wrapField("Description", descriptionInput);
    fields.append(titleField, tagsField, descField);
    row.append(handle, thumb, fields, deleteButton);

    return row;
};

// Field helpers
const createField = (label, type, value) => {
    if (type === "textarea") {
        const el = document.createElement("textarea");
        el.value = value;
        return el;
    }
    const el = document.createElement("input");
    el.type = "text";
    el.value = value;
    return el;
};

const wrapField = (labelText, inputEl) => {
    const field = document.createElement("div");
    field.className = "field";
    const label = document.createElement("label");
    label.textContent = labelText;
    field.append(label, inputEl);
    return field;
};

// ---------------------------------------------------------------------------
// Dashboard render / load
// ---------------------------------------------------------------------------

const renderDashboard = (items) => {
    dashboardList.innerHTML = "";

    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No drawings yet.";
        dashboardList.appendChild(empty);
        return;
    }

    items.forEach((item) => dashboardList.appendChild(createRow(item)));
};

const loadDashboard = async () => {
    const response = await fetch("/api/images");
    const items = await response.json();
    renderDashboard(items);
};

// ---------------------------------------------------------------------------
// Upload form: tag editor + picker
// ---------------------------------------------------------------------------

const uploadTagEditor = createTagEditor([], (tags) => {
    uploadTagsField.value = JSON.stringify(tags);
});
uploadTagsEditorRoot.replaceWith(uploadTagEditor.element);
uploadTagsField.value = "[]";

createTagPicker(uploadTagPickerRoot, uploadTagEditor.getTags, (tag) => {
    uploadTagEditor.addTag(tag);
    uploadTagsField.value = JSON.stringify(uploadTagEditor.getTags());
});

// ---------------------------------------------------------------------------
// Upload form: file selection + submit
// ---------------------------------------------------------------------------

uploadImageInput.addEventListener("change", () => {
    Array.from(uploadImageInput.files || []).forEach((file) => {
        pendingUploads.push({ file, previewUrl: URL.createObjectURL(file) });
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
    pendingUploads.forEach((entry) => formData.append("image", entry.file));

    try {
        const response = await fetch("/api/images", { method: "POST", body: formData });
        if (!response.ok) throw new Error("Unable to upload image.");
        uploadForm.reset();
        uploadTagEditor.reset();
        clearPendingUploads();
        setStatus("Image uploaded.");
        await loadDashboard();
    } catch (error) {
        setStatus(error.message, true);
    }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const boot = async () => {
    await fetchTagLibrary();
    renderTagLibrary();
    renderUploadPreviews();
    await loadDashboard();
};

boot();
