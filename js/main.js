// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
        image_urls: imageUrls,
    };
};

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const gallery = document.getElementById("gallery");
const viewer = document.getElementById("viewer");
const viewerBackdrop = document.getElementById("viewerBackdrop");
const viewerImages = document.getElementById("viewerImages");
const viewerTitle = document.getElementById("viewerTitle");
const viewerTags = document.getElementById("viewerTags");
const viewerDescription = document.getElementById("viewerDescription");
const viewerClose = document.getElementById("viewerClose");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let allArtworks = [];
let currentIndex = -1;
let zoomedImage = null;

// Touch / swipe state
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let isSwiping = false;

// Pinch-zoom state (mobile)
let pinchStartDist = 0;
let pinchScale = 1;
let isPinching = false;
let pinchTarget = null;

// ---------------------------------------------------------------------------
// Tags display
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Zoom (desktop: click-to-zoom, mobile: pinch-to-zoom)
// ---------------------------------------------------------------------------

const resetZoom = () => {
    if (!zoomedImage) return;
    const image = zoomedImage;
    image.classList.remove("is-zoomed");
    image.style.transform = "";
    zoomedImage = null;
    pinchScale = 1;

    window.setTimeout(() => {
        image.style.transformOrigin = "center center";
    }, 180);
};

const getZoomOrigin = (image, clientX, clientY) => {
    const bounds = image.getBoundingClientRect();
    const x = Math.min(100, Math.max(0, ((clientX - bounds.left) / bounds.width) * 100));
    const y = Math.min(100, Math.max(0, ((clientY - bounds.top) / bounds.height) * 100));
    return `${x}% ${y}%`;
};

const toggleZoom = (image, event) => {
    if (zoomedImage && zoomedImage !== image) resetZoom();

    if (zoomedImage === image) {
        resetZoom();
        return;
    }

    image.style.transformOrigin = getZoomOrigin(image, event.clientX, event.clientY);
    image.classList.add("is-zoomed");
    zoomedImage = image;
};

// Pinch helpers
const getPinchDist = (touches) => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
};

const getPinchCenter = (touches) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
});

// ---------------------------------------------------------------------------
// Viewer image creation
// ---------------------------------------------------------------------------

const createViewerImage = (src, alt) => {
    const item = document.createElement("div");
    const image = document.createElement("img");

    item.className = "viewer-image-item";
    image.src = src;
    image.alt = alt;
    image.draggable = false;

    // Desktop click-to-zoom
    image.addEventListener("click", (event) => {
        event.stopPropagation();
        toggleZoom(image, event);
    });

    // Desktop hover-pan while zoomed
    image.addEventListener("mousemove", (event) => {
        if (zoomedImage === image) {
            zoomedImage.style.transformOrigin = getZoomOrigin(image, event.clientX, event.clientY);
        }
    });

    // Mobile pinch-to-zoom
    image.addEventListener("touchstart", (event) => {
        if (event.touches.length === 2) {
            event.preventDefault();
            isPinching = true;
            pinchTarget = image;
            pinchStartDist = getPinchDist(event.touches);
            const center = getPinchCenter(event.touches);
            image.style.transformOrigin = getZoomOrigin(image, center.x, center.y);
        }
    }, { passive: false });

    image.addEventListener("touchmove", (event) => {
        if (isPinching && event.touches.length === 2 && pinchTarget === image) {
            event.preventDefault();
            const dist = getPinchDist(event.touches);
            pinchScale = Math.max(1, Math.min(4, dist / pinchStartDist * (zoomedImage === image ? 2.2 : 1)));

            if (pinchScale > 1.2) {
                image.classList.add("is-zoomed");
                image.style.transform = `scale(${pinchScale})`;
                zoomedImage = image;
                const center = getPinchCenter(event.touches);
                image.style.transformOrigin = getZoomOrigin(image, center.x, center.y);
            }
        }
    }, { passive: false });

    image.addEventListener("touchend", (event) => {
        if (isPinching) {
            isPinching = false;
            pinchTarget = null;

            if (pinchScale <= 1.2) {
                resetZoom();
            } else {
                // Snap to standard zoom level
                image.style.transform = "";
                pinchScale = 1;
            }
        }
    });

    item.appendChild(image);
    return item;
};

// ---------------------------------------------------------------------------
// Viewer navigation (prev / next across all gallery artworks)
// ---------------------------------------------------------------------------

const showArtwork = (artwork) => {
    resetZoom();
    viewerImages.innerHTML = "";
    viewerTitle.textContent = artwork.title;
    renderTags(viewerTags, artwork.tags || []);
    viewerDescription.textContent = artwork.description || "";

    artwork.image_urls.forEach((url) => {
        viewerImages.appendChild(createViewerImage(url, artwork.title));
    });

    viewerImages.scrollTop = 0;
};

const openViewer = (artwork) => {
    currentIndex = allArtworks.findIndex((a) => a.id === artwork.id);
    showArtwork(artwork);
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
    currentIndex = -1;
};

const navigateViewer = (direction) => {
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= allArtworks.length) return;
    currentIndex = nextIndex;
    showArtwork(allArtworks[currentIndex]);
};

// ---------------------------------------------------------------------------
// Gallery rendering
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const loadGallery = async () => {
    try {
        const response = await fetch("data/images.json");

        if (!response.ok) {
            allArtworks = [];
        } else {
            allArtworks = (await response.json()).map(normalizeArtwork);
        }
    } catch {
        allArtworks = [];
    }

    allArtworks = allArtworks.slice();
    renderGallery(allArtworks);
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

// Close viewer
viewerClose.addEventListener("click", closeViewer);

// Click outside image to close (backdrop)
viewerBackdrop.addEventListener("click", closeViewer);

// Click on viewer content area but NOT on image/info → close
viewer.addEventListener("click", (event) => {
    // Only close if clicking directly on the viewer overlay or viewer-content background
    const target = event.target;
    if (
        target === viewer ||
        target.classList.contains("viewer-content") ||
        target.classList.contains("viewer-image-wrap")
    ) {
        if (zoomedImage) {
            resetZoom();
            return;
        }
        closeViewer();
    }
});

// Reset zoom on scroll
viewerImages.addEventListener("scroll", () => {
    if (zoomedImage) resetZoom();
});

// Keyboard: Escape, ArrowLeft, ArrowRight
document.addEventListener("keydown", (event) => {
    if (!viewer.classList.contains("is-open")) return;

    if (event.key === "Escape") {
        if (zoomedImage) {
            resetZoom();
        } else {
            closeViewer();
        }
        return;
    }

    if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateViewer(-1);
        return;
    }

    if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateViewer(1);
        return;
    }
});

// Swipe navigation (mobile) — on the entire viewer
viewer.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1) return;
    if (zoomedImage) return;

    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchStartTime = Date.now();
    isSwiping = false;
}, { passive: true });

viewer.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) return;
    if (zoomedImage) return;

    const dx = event.touches[0].clientX - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;

    // Only treat as swipe if horizontal movement dominates
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 15) {
        isSwiping = true;
    }
}, { passive: true });

viewer.addEventListener("touchend", (event) => {
    if (!isSwiping) return;
    if (zoomedImage) return;

    const dx = event.changedTouches[0].clientX - touchStartX;
    const elapsed = Date.now() - touchStartTime;

    // Require minimum distance and maximum time for a swipe
    if (Math.abs(dx) > 50 && elapsed < 500) {
        navigateViewer(dx > 0 ? -1 : 1);
    }

    isSwiping = false;
}, { passive: true });

// Boot
loadGallery();