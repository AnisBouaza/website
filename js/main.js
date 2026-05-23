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
// Zoom (desktop only: click-to-zoom; mobile uses native browser pinch-zoom)
// ---------------------------------------------------------------------------

const resetZoom = () => {
    if (!zoomedImage) return;
    const image = zoomedImage;

    // Ensure CSS transition is active for smooth snap-back
    image.style.transition = "";
    image.classList.remove("is-zoomed");
    image.style.transform = "";
    zoomedImage = null;

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

    // Desktop click-to-zoom only (mobile uses native browser pinch-zoom)
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

    item.appendChild(image);
    return item;
};

// ---------------------------------------------------------------------------
// Viewer navigation
// ---------------------------------------------------------------------------
// The URL hash (#<id>) is the single source of truth for which artwork is
// open. openViewer/closeViewer update the hash; a hashchange listener reacts
// to the hash and actually opens/closes the viewer. This makes the browser
// back button close the viewer naturally and makes every artwork shareable.

let isHandlingHashChange = false;

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

const showViewer = (artwork) => {
    currentIndex = allArtworks.findIndex((a) => a.id === artwork.id);
    showArtwork(artwork);
    viewer.classList.add("is-open");
    viewer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
};

const hideViewer = () => {
    resetZoom();
    viewer.classList.remove("is-open");
    viewer.setAttribute("aria-hidden", "true");
    viewerImages.innerHTML = "";
    document.body.style.overflow = "";
    currentIndex = -1;
};

// Public actions — these update the URL hash, and the hashchange listener
// below does the actual viewer work. That keeps back-button + direct-URL +
// click-to-open all going through the same code path.

const openViewer = (artwork) => {
    if (location.hash === `#${artwork.id}`) {
        // Hash already matches (e.g. on initial page load) — open directly
        showViewer(artwork);
    } else {
        location.hash = `#${artwork.id}`;
    }
};

const closeViewer = () => {
    if (location.hash) {
        // Going back removes the hash and triggers hashchange, which hides the viewer
        history.back();
    } else {
        hideViewer();
    }
};

const navigateViewer = (direction) => {
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= allArtworks.length) return;
    // replaceState swaps the hash without adding a history entry, so the
    // back button still closes the viewer in one step regardless of how
    // many artworks you arrowed through.
    isHandlingHashChange = true;
    history.replaceState(null, "", `#${allArtworks[nextIndex].id}`);
    isHandlingHashChange = false;
    currentIndex = nextIndex;
    showArtwork(allArtworks[currentIndex]);
};

const handleHashChange = () => {
    if (isHandlingHashChange) return;
    const hash = location.hash.replace(/^#/, "");
    if (!hash) {
        if (viewer.classList.contains("is-open")) hideViewer();
        return;
    }
    const artwork = allArtworks.find((a) => String(a.id) === hash);
    if (artwork) {
        showViewer(artwork);
    } else {
        // Stale or invalid hash — clean it up
        history.replaceState(null, "", location.pathname + location.search);
        if (viewer.classList.contains("is-open")) hideViewer();
    }
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

    // If the page was loaded with a hash (#42), open that artwork now
    if (location.hash) handleHashChange();
};

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

viewerClose.addEventListener("click", closeViewer);
viewerBackdrop.addEventListener("click", closeViewer);

window.addEventListener("hashchange", handleHashChange);

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

// Boot
loadGallery();