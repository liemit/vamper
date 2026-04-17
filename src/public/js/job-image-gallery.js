document.addEventListener('DOMContentLoaded', function () {
    const descContent = document.getElementById('job-description-content');
    const toggleBtn = document.getElementById('toggle-image-view');

    if (!descContent || !toggleBtn) return;

    const allImgs = Array.from(descContent.querySelectorAll('img'));
    if (!allImgs.length) return;

    // Filter out emoji/icons — wait for images to load first to check naturalWidth
    function isRealImage(img) {
        // Skip by class or attribute
        if (img.classList.contains('emoji') || img.dataset.emoji !== undefined) return false;
        // Skip by src pattern
        const src = img.src || '';
        if (/emoji|twemoji|emojipedia|icon/i.test(src)) return false;
        // Skip by explicit size attributes
        const w = parseInt(img.getAttribute('width') || '0');
        const h = parseInt(img.getAttribute('height') || '0');
        if ((w > 0 && w < 60) || (h > 0 && h < 60)) return false;
        // Skip by natural size
        if (img.naturalWidth > 0 && img.naturalWidth < 60) return false;
        if (img.naturalHeight > 0 && img.naturalHeight < 60) return false;
        return true;
    }

    // Wait for all images to load, then build gallery with real images only
    Promise.all(allImgs.map(img => new Promise(resolve => {
        if (img.complete) return resolve();
        img.onload = img.onerror = resolve;
    }))).then(() => {
        const images = allImgs.filter(isRealImage);
        if (images.length < 2) return;
        buildGallery(images);
    });

    function buildGallery(images) {
        toggleBtn.classList.remove('d-none');

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

        function getNonImageNodes() {
            return Array.from(descContent.childNodes).filter(node => {
                if (imgContainers.includes(node)) return false;
                if (node.nodeType === Node.ELEMENT_NODE && node.querySelectorAll('img').length > 0) {
                    const hasOnlyImages = Array.from(node.childNodes).every(
                        child => child.nodeType !== Node.TEXT_NODE || child.textContent.trim() === ''
                    );
                    if (hasOnlyImages) return false;
                }
                return true;
            });
        }

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
            descContent.insertBefore(gallery, descContent.firstChild);
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

        showGrid();

        toggleBtn.addEventListener('click', function () {
            if (isGridView) showList();
            else showGrid();
        });
    }
});
