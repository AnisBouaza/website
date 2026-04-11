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

const isMobile = () => window.innerWidth <= 800;

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
let touchDirectionLocked = false;

// Pinch-zoom state (mobile)
let pinchStartDist = 0;
let pinchScale = 1;
let isPinching = false;
let pinchTarget = null;

// ---------------------------------------------------------------------------
// Fade-in animation
// ---------------------------------------------------------------------------
// Two-phase: items in the initial viewport get a staggered delay on first
// paint. Items below the fold use IntersectionObserver for scroll-triggered
// fade-in.

let revealBatch = 0;

const fadeObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
        if (entry.isIntersecting) {
            const el = entry.target;
            fadeObserver.unobserve(el);
            // Small delay so the transition is visible even if observed immediately
            requestAnimationFrame(() => {
                el.classList.add("is-visible");
            });
        }
    });
}, { threshold: 0.05, rootMargin: "0px 0px 80px 0px" });

const observeWithStagger = (item, index) => {
    // For the initial batch, stagger the reveal so items cascade in
    // requestAnimationFrame ensures the browser has painted opacity:0 first
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const delay = index * 60; // 60ms between each item
            item.style.transitionDelay = `${delay}ms`;
            fadeObserver.observe(item);

            // Remove the delay after the animation so it doesn't affect hover etc.
            const cleanup = () => {
                item.style.transitionDelay = "";
                item.removeEventListener("transitionend", cleanup);
            };
            item.addEventListener("transitionend", cleanup);
        });
    });
};

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

    // Ensure CSS transition is active for smooth snap-back
    image.style.transition = "";
    image.classList.remove("is-zoomed");
    image.style.transform = "";
    zoomedImage = null;
    pinchScale = 1;

    window.setTimeout(() => {
        image.style.transformOrigin = "center center";
    }, 320);
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

    // Desktop click-to-zoom only
    image.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!isMobile()) toggleZoom(image, event);
    });

    // Desktop hover-pan while zoomed
    image.addEventListener("mousemove", (event) => {
        if (zoomedImage === image) {
            zoomedImage.style.transformOrigin = getZoomOrigin(image, event.clientX, event.clientY);
        }
    });

    // Mobile pinch-to-zoom — smooth with transition control
    image.addEventListener("touchstart", (event) => {
        if (event.touches.length === 2) {
            isPinching = true;
            pinchTarget = image;
            pinchStartDist = getPinchDist(event.touches);

            // Disable CSS transition during active pinch for responsive feel
            image.style.transition = "none";

            const center = getPinchCenter(event.touches);
            image.style.transformOrigin = getZoomOrigin(image, center.x, center.y);

            // If already zoomed, start from current scale
            if (zoomedImage !== image) {
                pinchScale = 1;
            }
        }
    }, { passive: true });

    image.addEventListener("touchmove", (event) => {
        if (isPinching && event.touches.length === 2 && pinchTarget === image) {
            event.preventDefault();
            const dist = getPinchDist(event.touches);
            const rawScale = dist / pinchStartDist;

            // Smooth scale from current base
            pinchScale = Math.max(1, Math.min(5, rawScale * (zoomedImage === image ? 2.2 : 1)));

            image.style.transform = `scale(${pinchScale})`;

            if (pinchScale > 1.05) {
                image.classList.add("is-zoomed");
                zoomedImage = image;
                const center = getPinchCenter(event.touches);
                image.style.transformOrigin = getZoomOrigin(image, center.x, center.y);
            }
        }
    }, { passive: false });

    image.addEventListener("touchend", () => {
        if (isPinching) {
            isPinching = false;
            pinchTarget = null;

            // Re-enable smooth transition for snap-back
            image.style.transition = "";

            if (pinchScale <= 1.3) {
                // Snap back to normal smoothly
                resetZoom();
            } else {
                // Snap to standard 2.2x zoom level smoothly
                image.style.transform = "";
                pinchScale = 1;
            }
        }
    });

    item.appendChild(image);
    return item;
};

// ---------------------------------------------------------------------------
// Viewer navigation
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

    // On mobile the whole viewer scrolls; on desktop the images container scrolls
    viewer.scrollTop = 0;
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
// Thumbnail helper
// ---------------------------------------------------------------------------

const thumbUrl = (url) => url.replace("/uploads/", "/uploads/thumbs/");

// ---------------------------------------------------------------------------
// Gallery rendering
// ---------------------------------------------------------------------------

const createGalleryItem = (artwork, index) => {
    const item = document.createElement("button");
    const image = document.createElement("img");

    item.className = "gallery-item";
    item.type = "button";

    // Use thumbnail for gallery grid, fall back to original
    image.src = thumbUrl(artwork.image_url);
    image.alt = artwork.title;
    image.draggable = false;
    image.loading = "lazy";

    image.addEventListener("error", () => {
        if (image.src !== artwork.image_url) {
            image.src = artwork.image_url;
        }
    });

    item.appendChild(image);

    if (artwork.image_urls.length > 1) {
        const badge = document.createElement("span");
        badge.className = "gallery-badge";
        badge.innerHTML = "<span></span><span></span>";
        item.appendChild(badge);
    }

    item.addEventListener("click", () => openViewer(artwork));

    // Staggered fade-in
    observeWithStagger(item, index);

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

    artworks.forEach((artwork, index) => {
        gallery.appendChild(createGalleryItem(artwork, index));
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

    renderGallery(allArtworks);
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

viewerClose.addEventListener("click", closeViewer);
viewerBackdrop.addEventListener("click", closeViewer);

viewer.addEventListener("click", (event) => {
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

// Reset zoom on any scroll
viewerImages.addEventListener("scroll", () => { if (zoomedImage) resetZoom(); });
viewer.addEventListener("scroll", () => { if (zoomedImage) resetZoom(); });

// Keyboard
document.addEventListener("keydown", (event) => {
    if (!viewer.classList.contains("is-open")) return;

    if (event.key === "Escape") {
        zoomedImage ? resetZoom() : closeViewer();
        return;
    }
    if (event.key === "ArrowLeft") { event.preventDefault(); navigateViewer(-1); }
    if (event.key === "ArrowRight") { event.preventDefault(); navigateViewer(1); }
});

// Swipe navigation (mobile) with direction locking
viewer.addEventListener("touchstart", (event) => {
    if (event.touches.length !== 1 || zoomedImage) return;
    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchStartTime = Date.now();
    isSwiping = false;
    touchDirectionLocked = false;
}, { passive: true });

viewer.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1 || zoomedImage || touchDirectionLocked) return;

    const dx = event.touches[0].clientX - touchStartX;
    const dy = event.touches[0].clientY - touchStartY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    if (absDx < 10 && absDy < 10) return;

    if (absDy > absDx) {
        touchDirectionLocked = true;
        isSwiping = false;
        return;
    }

    if (absDx > 30 && absDx > absDy * 2) {
        isSwiping = true;
    }
}, { passive: true });

viewer.addEventListener("touchend", (event) => {
    if (!isSwiping || zoomedImage) return;
    const dx = event.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 60 && (Date.now() - touchStartTime) < 400) {
        navigateViewer(dx > 0 ? -1 : 1);
    }
    isSwiping = false;
}, { passive: true });

// Boot
loadGallery();