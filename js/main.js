const gallery = document.getElementById("gallery");
const viewer = document.getElementById("viewer");
const viewerImages = document.getElementById("viewerImages");
const viewerTitle = document.getElementById("viewerTitle");
const viewerTags = document.getElementById("viewerTags");
const viewerDescription = document.getElementById("viewerDescription");
const viewerClose = document.getElementById("viewerClose");
let zoomedImage = null;

const renderTags = (container, tags) => {
    container.innerHTML = "";

    if (!tags.length) {
        container.style.display = "none";
        return;
    }

    container.style.display = "flex";

    tags.forEach((tag) => {
        const chip = document.createElement("span");
        chip.className = "tag-chip";
        chip.textContent = tag;
        container.appendChild(chip);
    });
};

const resetZoom = () => {
    if (!zoomedImage) {
        return;
    }

    const image = zoomedImage;
    image.classList.remove("is-zoomed");
    zoomedImage = null;

    window.setTimeout(() => {
        image.style.transformOrigin = "center center";
    }, 180);
};

const getZoomOrigin = (image, event) => {
    const bounds = image.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    const originX = Math.min(100, Math.max(0, x));
    const originY = Math.min(100, Math.max(0, y));

    return `${originX}% ${originY}%`;
};

const toggleZoom = (image, event) => {
    if (zoomedImage && zoomedImage !== image) {
        resetZoom();
    }

    if (zoomedImage === image) {
        resetZoom();
        return;
    }

    image.style.transformOrigin = getZoomOrigin(image, event);
    image.classList.add("is-zoomed");
    zoomedImage = image;
};

const updateZoomOrigin = (event) => {
    if (!zoomedImage) {
        return;
    }

    zoomedImage.style.transformOrigin = getZoomOrigin(zoomedImage, event);
};

const createViewerImage = (src, alt) => {
    const item = document.createElement("div");
    const image = document.createElement("img");

    item.className = "viewer-image-item";
    image.src = src;
    image.alt = alt;
    image.draggable = false;
    image.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleZoom(image, event);
    });
    image.addEventListener("mousemove", (event) => {
        if (zoomedImage === image) {
            updateZoomOrigin(event);
        }
    });
    item.appendChild(image);

    return item;
};

const openViewer = (artwork) => {
    resetZoom();
    viewerImages.innerHTML = "";
    viewerTitle.textContent = artwork.title;
    renderTags(viewerTags, artwork.tags || []);
    viewerDescription.textContent = artwork.description || "";
    artwork.image_urls.forEach((imageUrl) => {
        viewerImages.appendChild(createViewerImage(imageUrl, artwork.title));
    });
    viewer.classList.add("is-open");
    viewer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
};

const closeViewer = () => {
    resetZoom();
    viewer.classList.remove("is-open");
    viewer.setAttribute("aria-hidden", "true");
    viewerImages.innerHTML = "";
    document.body.style.overflow = "";
};

const createGalleryItem = (artwork) => {
    const item = document.createElement("button");
    const image = document.createElement("img");

    item.className = "gallery-item";
    item.type = "button";
    image.src = artwork.image_url;
    image.alt = artwork.title;
    image.draggable = false;

    item.appendChild(image);

    if (artwork.image_urls.length > 1) {
        const badge = document.createElement("span");
        badge.className = "gallery-badge";
        badge.innerHTML = "<span></span><span></span>";
        item.appendChild(badge);
    }

    item.addEventListener("click", () => openViewer(artwork));
    return item;
};

const renderGallery = (artworks) => {
    gallery.innerHTML = "";

    if (!artworks.length) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No drawings yet.";
        gallery.appendChild(empty);
        return;
    }

    artworks.forEach((artwork) => {
        gallery.appendChild(createGalleryItem(artwork));
    });
};

const normalizeArtwork = (artwork) => {
    const imageUrls = Array.isArray(artwork.image_urls)
        ? artwork.image_urls
        : Array.isArray(artwork.image_paths)
            ? artwork.image_paths
            : [artwork.image_url || artwork.image_path].filter(Boolean);

    return {
        id: artwork.id,
        title: artwork.title,
        description: artwork.description || "",
        tags: Array.isArray(artwork.tags) ? artwork.tags : [],
        image_url: imageUrls[0] || "",
        image_urls: imageUrls
    };
};

const loadGallery = async () => {
    try {
        const response = await fetch("data/images.json");

        if (!response.ok) {
            renderGallery([]);
            return;
        }

        const artworks = await response.json();
        renderGallery(artworks.map(normalizeArtwork));
    } catch (error) {
        renderGallery([]);
    }
};

viewerClose.addEventListener("click", closeViewer);

viewer.addEventListener("click", (event) => {
    if (event.target === viewer) {
        closeViewer();
    }
});

viewerImages.addEventListener("scroll", () => {
    if (zoomedImage) {
        resetZoom();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && viewer.classList.contains("is-open")) {
        if (zoomedImage) {
            resetZoom();
            return;
        }

        closeViewer();
    }
});

loadGallery();
