document.addEventListener('DOMContentLoaded', function () {
    const descContent = document.getElementById('job-description-content');
    const toggleBtn = document.getElementById('toggle-image-view');

    if (!descContent || !toggleBtn) return;

    const images = Array.from(descContent.querySelectorAll('img'));
    if (images.length < 2) return;

    toggleBtn.classList.remove('d-none');

    // Find containers to hide - only hide the <p> if it contains ONLY images (no text)
    function getImgContainer(img) {
        const p = img.closest('p');
        if (p) {
            const hasText = Array.from(p.childNodes).some(
                node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0
            );
            if (!hasText && p.querySelectorAll(':not(img)').length === 0) return p;
        }
        return img;
    }

    const imgContainers = images.map(img => getImgContainer(img));

    // Collect non-image nodes (text content) to move below gallery
    function getNonImageNodes() {
        return Array.from(descContent.childNodes).filter(node => {
            if (imgContainers.includes(node)) return false;
            if (node.nodeType === Node.ELEMENT_NODE && node.querySelectorAll('img').length > 0) {
                // element that contains images - skip
                const hasOnlyImages = Array.from(node.childNodes).every(
                    child => child.nodeType !== Node.TEXT_NODE || child.textContent.trim() === ''
                );
                if (hasOnlyImages) return false;
            }
            return true;
        });
    }

    // Build gallery
    const gallery = document.createElement('div');
    gallery.className = 'job-image-gallery';
    gallery.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px;';

    images.forEach(img => {
        const thumb = document.createElement('img');
        thumb.src = img.src;
        thumb.alt = img.alt || '';
        thumb.title = 'Click to view full size';
        thumb.style.cssText = 'width:100%;height:160px;object-fit:cover;border-radius:8px;cursor:pointer;display:block;';
        thumb.addEventListener('click', () => window.open(img.src, '_blank'));
        gallery.appendChild(thumb);
    });

    let isGridView = false;

    function showGrid() {
        isGridView = true;
        imgContainers.forEach(el => { el.style.display = 'none'; });

        // Insert gallery at the top of descContent
        descContent.insertBefore(gallery, descContent.firstChild);

        // Move non-image nodes after gallery
        const textNodes = getNonImageNodes().filter(n => n !== gallery);
        textNodes.forEach(node => descContent.appendChild(node));

        toggleBtn.innerHTML = '<i class="bi bi-list-ul"></i>';
        toggleBtn.title = 'Switch to list view';
    }

    function showList() {
        isGridView = false;
        imgContainers.forEach(el => { el.style.display = ''; });
        if (gallery.parentNode) gallery.parentNode.removeChild(gallery);
        toggleBtn.innerHTML = '<i class="bi bi-grid-3x3-gap-fill"></i>';
        toggleBtn.title = 'Switch to grid gallery view';
    }

    // Default: grid
    showGrid();

    toggleBtn.addEventListener('click', function () {
        if (isGridView) showList();
        else showGrid();
    });
});
